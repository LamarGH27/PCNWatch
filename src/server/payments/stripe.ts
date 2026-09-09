import { createHmac, timingSafeEqual } from 'node:crypto';
import { serverEnv, isConfigured } from '@/lib/env';
import { AppError, logError } from '@/lib/errors';
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
  /**
   * Distinguishes one attempt from the next.
   *
   * The idempotency key used to be `checkout:user:case:sku`, which is stable
   * for the life of the case — so a user who reached Stripe, cancelled, and
   * came back got Stripe's cached response for the dead session rather than a
   * new one. Stripe caches an idempotent response for 24 hours, so the retry
   * failed silently for a day.
   *
   * The pending payment row's id is created once per attempt, which is exactly
   * the granularity wanted: a double-tap reuses one attempt and cannot produce
   * two sessions, and a genuine retry after a cancellation is a new attempt and
   * gets a new session.
   */
  readonly attemptId: string;
}

export interface CheckoutSession {
  readonly id: string;
  readonly url: string;
  /** Unix seconds. Stripe expires a Checkout Session after 24 hours. */
  readonly expiresAt: number | null;
  /**
   * The Price actually sent, returned rather than re-read by the caller.
   *
   * Two independent reads of the same variable is one more than is needed, and
   * the recorded value would silently disagree with the charged one if they
   * ever diverged.
   */
  readonly priceId: string;
}

export async function createCheckoutSession(
  request: CheckoutSessionRequest,
): Promise<CheckoutSession> {
  if (!isConfigured('stripe')) throw new StripeNotConfiguredError();
  const env = serverEnv();

  const priceId = process.env[request.product.stripePriceEnvKey];
  if (!priceId) {
    /*
     * Refuses rather than falling back to an inline price.
     *
     * An inline price would charge the right amount — it comes from the server
     * catalogue either way — and it would mean a misconfigured deployment
     * taking real money against a Price that does not exist in the dashboard.
     * That reconciles to nothing, and nobody notices until somebody asks where
     * a payment came from.
     */
    throw new AppError(
      'STRIPE_PRICE_NOT_CONFIGURED',
      'Payments are not fully configured on this deployment.',
      'Nothing has been charged. Everything free continues to work.',
      { dataSaved: false, severity: 'RECOVERABLE' },
    );
  }

  const body = new URLSearchParams({
    mode: 'payment',
    success_url: request.successUrl,
    cancel_url: request.cancelUrl,
    // Metadata is how the webhook knows what was bought and for whom. It is
    // authoritative because Stripe echoes back exactly what we set here.
    /*
     * Three opaque identifiers and nothing else.
     *
     * Stripe needs to be able to tell us what was bought and for whom. It does
     * not need — and must never receive — the PCN number, the registration,
     * the location, the user's account of what happened, or anything read off
     * their evidence. Two uuids and a product key say everything required and
     * disclose nothing about the case.
     */
    'metadata[user_id]': request.userId,
    'metadata[case_id]': request.caseId,
    'metadata[product_sku]': request.product.sku,
    'payment_intent_data[metadata][user_id]': request.userId,
    'payment_intent_data[metadata][case_id]': request.caseId,
    'payment_intent_data[metadata][product_sku]': request.product.sku,
  });

  if (request.customerEmail) body.set('customer_email', request.customerEmail);

  body.set('line_items[0][price]', priceId);
  body.set('line_items[0][quantity]', '1');

  const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'content-type': 'application/x-www-form-urlencoded',
      // One attempt, one session. See `attemptId`.
      'idempotency-key': `checkout:${request.attemptId}`,
    },
    body,
  });

  if (!response.ok) {
    /*
     * Say why, in the log, without saying anything that must not be in a log.
     *
     * The first real Checkout failure was a Stripe Price configured as
     * recurring against a `mode: payment` session. Stripe said so precisely;
     * this code discarded the answer and raised "we could not start the
     * payment", so the only way to find out was the Stripe dashboard.
     *
     * What is recorded is the diagnostic envelope and nothing else: the error
     * type, the machine-readable code, the offending parameter, the HTTP
     * status and Stripe's request id. Deliberately NOT the human message —
     * it is Stripe's prose rather than a field we control, and the request id
     * fetches it from the dashboard, which is the safe channel for it. Never
     * the key, never the request body, never anything about the case.
     */
    await logStripeFailure(response, 'checkout.session');
    throw new AppError(
      'STRIPE_CHECKOUT_FAILED',
      'We could not start the payment.',
      'Nothing has been charged. Please try again in a moment.',
      { dataSaved: false, severity: 'RECOVERABLE' },
    );
  }

  const session = (await response.json()) as {
    id?: string;
    url?: string;
    expires_at?: number;
  };
  if (!session.id || !session.url) {
    throw new AppError(
      'STRIPE_CHECKOUT_INCOMPLETE',
      'The payment page could not be opened.',
      'Nothing has been charged. Please try again.',
      { dataSaved: false, severity: 'RECOVERABLE' },
    );
  }

  return {
    id: session.id,
    url: session.url,
    expiresAt: typeof session.expires_at === 'number' ? session.expires_at : null,
    priceId,
  };
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
  /** From the event. Whether real money moved, rather than what was configured. */
  readonly livemode: boolean;
}

export type CheckoutInterpretation =
  | { readonly kind: 'COMPLETED'; readonly checkout: CompletedCheckout }
  /** A session that will never be paid. Closes the attempt; grants nothing. */
  | { readonly kind: 'EXPIRED'; readonly sessionId: string }
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

  /*
   * Two event types complete a Checkout Session, and a card payment is the
   * first. The second arrives when a delayed method settles later; handling it
   * costs one line and means a payment method we might enable in the dashboard
   * does not silently fail to grant.
   */
  const GRANTING_TYPES = ['checkout.session.completed', 'checkout.session.async_payment_succeeded'];
  if (type !== 'checkout.session.expired' && !GRANTING_TYPES.includes(type ?? '')) {
    return { kind: 'IGNORED', reason: `Event type "${type}" does not grant entitlements.` };
  }

  const session = data?.object;
  if (!session) return { kind: 'INVALID', reason: 'The event carried no session object.' };

  /*
   * An expired session is the end of an attempt, not a payment.
   *
   * Handled here rather than ignored so the pending row stops looking like an
   * attempt still in flight — otherwise a user who abandons checkout has a row
   * that reads PENDING forever, and the next attempt reuses a dead session.
   */
  if (type === 'checkout.session.expired') {
    const sessionId = String(session.id ?? '');
    if (!sessionId) return { kind: 'INVALID', reason: 'The expired event carried no session id.' };
    return { kind: 'EXPIRED', sessionId };
  }

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

  /*
   * The amount check is meaningless without this one.
   *
   * `amount_total` is an integer in the session's own currency, so 599 USD
   * cents satisfies "at least 599" while being worth appreciably less than
   * £5.99. Nothing in the request chooses the currency — the Price fixes it in
   * the dashboard — which is exactly why this is worth checking: the way it
   * goes wrong is a Price recreated in Live mode with the currency picker left
   * on its default, and the failure is silent in the direction of granting.
   */
  const currency = String(session.currency ?? '').toUpperCase();
  if (currency !== product.currency) {
    return {
      kind: 'INVALID',
      reason: `Session currency is ${currency || '(none)'}, but ${product.sku} is priced in ${product.currency}.`,
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
      currency,
      livemode: (event as { livemode?: boolean }).livemode === true,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Charge lookup                                                       */
/* ------------------------------------------------------------------ */

/**
 * The charge a refund would be issued against.
 *
 * A Checkout Session carries a PaymentIntent, not a charge, so this is one
 * extra call. It is best effort by design: the charge id is for a human in the
 * Stripe dashboard six months from now, and failing to read it must never stop
 * a paid customer being granted what they paid for. Returns null on anything.
 */
export async function fetchLatestCharge(paymentIntentId: string): Promise<string | null> {
  try {
    if (!isConfigured('stripe')) return null;
    const env = serverEnv();
    const response = await fetch(
      `https://api.stripe.com/v1/payment_intents/${encodeURIComponent(paymentIntentId)}`,
      { headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } },
    );
    if (!response.ok) return null;
    const intent = (await response.json()) as { latest_charge?: unknown };
    return typeof intent.latest_charge === 'string' ? intent.latest_charge : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Diagnostics                                                         */
/* ------------------------------------------------------------------ */

/** Stripe's error envelope. Only the machine-readable half is ever read. */
interface StripeErrorEnvelope {
  readonly error?: {
    readonly type?: unknown;
    readonly code?: unknown;
    readonly decline_code?: unknown;
    readonly param?: unknown;
  };
}

/** Keeps a stray object out of the log line if Stripe ever changes shape. */
function scalar(value: unknown): string | null {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : null;
}

/**
 * Records why Stripe refused, from the fields that are safe to record.
 *
 * Best effort by design: a failure to read the diagnostic must not replace the
 * failure being diagnosed, so everything here is inside one try.
 */
export async function logStripeFailure(response: Response, operation: string): Promise<void> {
  let type: string | null = null;
  let code: string | null = null;
  let declineCode: string | null = null;
  let param: string | null = null;

  try {
    const body = (await response.clone().json()) as StripeErrorEnvelope;
    type = scalar(body.error?.type);
    code = scalar(body.error?.code);
    declineCode = scalar(body.error?.decline_code);
    param = scalar(body.error?.param);
  } catch {
    // A non-JSON body (a gateway error page) leaves the status and request id,
    // which is still enough to find the request in Stripe's logs.
  }

  logError('stripe.api', new Error(`Stripe refused ${operation}.`), {
    operation,
    status: response.status,
    stripeType: type,
    stripeCode: code,
    stripeDeclineCode: declineCode,
    // e.g. "line_items[0][price]" — a field name of ours, not a value of theirs.
    stripeParam: param,
    stripeRequestId: response.headers.get('request-id'),
  });
}
