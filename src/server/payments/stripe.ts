import { createHmac, timingSafeEqual } from 'node:crypto';
import { serverEnv, isConfigured } from '@/lib/env';
import { AppError } from '@/lib/errors';
import { getProduct, type Product } from './catalogue';

/**
 * Stripe integration.
 *
 * Written against the HTTP API directly rather than the SDK, so that signature
 * verification is explicit and reviewable rather than hidden behind a helper —
 * it is the security boundary for the entire payments flow.
 *
 * If Stripe is not configured, checkout refuses. It never falls back to marking
 * something as paid.
 */

export class StripeNotConfiguredError extends AppError {
  constructor() {
    super(
      'STRIPE_NOT_CONFIGURED',
      'Payments are not available on this deployment.',
      'Everything free continues to work. Please try again later.',
      { severity: 'RECOVERABLE' },
    );
  }
}

export interface CheckoutSessionRequest {
  readonly product: Product;
  readonly userId: string;
  readonly caseId: string;
  readonly customerEmail?: string;
  readonly successUrl: string;
  readonly cancelUrl: string;
}

export interface CheckoutSession {
  readonly id: string;
  readonly url: string;
}

export async function createCheckoutSession(
  request: CheckoutSessionRequest,
): Promise<CheckoutSession> {
  if (!isConfigured('stripe')) throw new StripeNotConfiguredError();
  const env = serverEnv();

  const priceId = process.env[request.product.stripePriceEnvKey];

  const body = new URLSearchParams({
    mode: 'payment',
    success_url: request.successUrl,
    cancel_url: request.cancelUrl,
    // Metadata is how the webhook knows what was bought and for whom. It is
    // authoritative because Stripe echoes back exactly what we set here.
    'metadata[user_id]': request.userId,
    'metadata[case_id]': request.caseId,
    'metadata[product_sku]': request.product.sku,
    'payment_intent_data[metadata][user_id]': request.userId,
    'payment_intent_data[metadata][case_id]': request.caseId,
    'payment_intent_data[metadata][product_sku]': request.product.sku,
  });

  if (request.customerEmail) body.set('customer_email', request.customerEmail);

  if (priceId) {
    body.set('line_items[0][price]', priceId);
    body.set('line_items[0][quantity]', '1');
  } else {
    // Falls back to an inline price built from the catalogue, so a missing Stripe
    // Price id cannot cause the wrong amount to be charged.
    body.set('line_items[0][price_data][currency]', request.product.currency.toLowerCase());
    body.set('line_items[0][price_data][unit_amount]', String(request.product.pricePence));
    body.set('line_items[0][price_data][product_data][name]', request.product.name);
    body.set('line_items[0][quantity]', '1');
  }

  const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'content-type': 'application/x-www-form-urlencoded',
      // Prevents a duplicate session if the user double-taps the button.
      'idempotency-key': `checkout:${request.userId}:${request.caseId}:${request.product.sku}`,
    },
    body,
  });

  if (!response.ok) {
    throw new AppError(
      'STRIPE_CHECKOUT_FAILED',
      'We could not start the payment.',
      'Nothing has been charged. Please try again in a moment.',
      { dataSaved: false, severity: 'RECOVERABLE' },
    );
  }

  const session = (await response.json()) as { id?: string; url?: string };
  if (!session.id || !session.url) {
    throw new AppError(
      'STRIPE_CHECKOUT_INCOMPLETE',
      'The payment page could not be opened.',
      'Nothing has been charged. Please try again.',
      { dataSaved: false, severity: 'RECOVERABLE' },
    );
  }

  return { id: session.id, url: session.url };
}

/* ------------------------------------------------------------------ */
/* Webhook signature verification                                      */
/* ------------------------------------------------------------------ */

export interface WebhookVerification {
  readonly valid: boolean;
  readonly reason: string | null;
}

/** Reject a signature whose timestamp is older than this, to blunt replay. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

/**
 * Verifies a Stripe webhook signature.
 *
 * The signature is computed over `${timestamp}.${rawBody}`, so the raw body must
 * be passed exactly as received — parsing and re-serialising it would change the
 * bytes and invalidate the signature.
 */
export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): WebhookVerification {
  if (!signatureHeader) return { valid: false, reason: 'No signature header was supplied.' };

  const parts = new Map<string, string[]>();
  for (const segment of signatureHeader.split(',')) {
    const [key, value] = segment.split('=', 2);
    if (!key || !value) continue;
    const existing = parts.get(key.trim()) ?? [];
    existing.push(value.trim());
    parts.set(key.trim(), existing);
  }

  const timestamp = parts.get('t')?.[0];
  const signatures = parts.get('v1') ?? [];
  if (!timestamp || signatures.length === 0) {
    return { valid: false, reason: 'The signature header was malformed.' };
  }

  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) {
    return { valid: false, reason: 'The signature timestamp was not a number.' };
  }
  if (Math.abs(nowSeconds - timestampSeconds) > WEBHOOK_TOLERANCE_SECONDS) {
    return { valid: false, reason: 'The signature timestamp is outside the accepted window.' };
  }

  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`, 'utf8')
    .digest('hex');

  // Constant-time comparison against each supplied signature.
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const matched = signatures.some((candidate) => {
    const candidateBuffer = Buffer.from(candidate, 'utf8');
    if (candidateBuffer.length !== expectedBuffer.length) return false;
    return timingSafeEqual(candidateBuffer, expectedBuffer);
  });

  return matched
    ? { valid: true, reason: null }
    : { valid: false, reason: 'The signature did not match.' };
}

/* ------------------------------------------------------------------ */
/* Event interpretation                                                */
/* ------------------------------------------------------------------ */

export interface CompletedCheckout {
  readonly sessionId: string;
  readonly paymentIntentId: string | null;
  readonly userId: string;
  readonly caseId: string | null;
  readonly productSku: string;
  readonly amountPence: number;
  readonly currency: string;
}

export type CheckoutInterpretation =
  | { readonly kind: 'COMPLETED'; readonly checkout: CompletedCheckout }
  | { readonly kind: 'IGNORED'; readonly reason: string }
  | { readonly kind: 'INVALID'; readonly reason: string };

/**
 * Reads a verified webhook event.
 *
 * Only a completed, paid checkout session grants anything. The amount is checked
 * against the catalogue so a tampered or stale session cannot unlock a product
 * for less than its price.
 */
export function interpretCheckoutEvent(event: unknown): CheckoutInterpretation {
  if (event === null || typeof event !== 'object') {
    return { kind: 'INVALID', reason: 'The event body was not an object.' };
  }

  const { type, data } = event as { type?: string; data?: { object?: Record<string, unknown> } };

  if (type !== 'checkout.session.completed') {
    return { kind: 'IGNORED', reason: `Event type "${type}" does not grant entitlements.` };
  }

  const session = data?.object;
  if (!session) return { kind: 'INVALID', reason: 'The event carried no session object.' };

  if (session.payment_status !== 'paid') {
    return {
      kind: 'IGNORED',
      reason: `Session payment_status is "${String(session.payment_status)}", not "paid".`,
    };
  }

  const metadata = (session.metadata ?? {}) as Record<string, string | undefined>;
  const userId = metadata.user_id;
  const productSku = metadata.product_sku;

  if (!userId || !productSku) {
    return { kind: 'INVALID', reason: 'The session metadata did not identify a user and product.' };
  }

  const product = getProduct(productSku);
  if (!product) {
    return { kind: 'INVALID', reason: `The session names an unknown product "${productSku}".` };
  }

  const amountPence = Number(session.amount_total ?? 0);
  if (amountPence < product.pricePence) {
    return {
      kind: 'INVALID',
      reason: `Amount paid (${amountPence}) is less than the price of ${product.sku} (${product.pricePence}).`,
    };
  }

  return {
    kind: 'COMPLETED',
    checkout: {
      sessionId: String(session.id ?? ''),
      paymentIntentId: session.payment_intent ? String(session.payment_intent) : null,
      userId,
      caseId: metadata.case_id ?? null,
      productSku,
      amountPence,
      currency: String(session.currency ?? 'gbp').toUpperCase(),
    },
  };
}
