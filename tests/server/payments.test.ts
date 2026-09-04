import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  WEBHOOK_TOLERANCE_SECONDS,
  interpretCheckoutEvent,
  verifyWebhookSignature,
} from '@/server/payments/stripe';
import { interpretCheckoutReturn } from '@/server/payments/entitlements';
import { PRODUCTS, entitlementsFor, getProduct } from '@/server/payments/catalogue';

const SECRET = 'whsec_test_secret';
const NOW = 1_800_000_000;

function sign(body: string, timestamp = NOW, secret = SECRET): string {
  const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

function completedSession(overrides: Record<string, unknown> = {}) {
  return {
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_123',
        payment_status: 'paid',
        payment_intent: 'pi_test_123',
        amount_total: 599,
        currency: 'gbp',
        metadata: {
          user_id: '11111111-1111-1111-1111-111111111111',
          case_id: '55555555-5555-5555-5555-555555555555',
          product_sku: 'PCNWATCH_DEFENCE',
        },
        ...overrides,
      },
    },
  };
}

describe('catalogue', () => {
  it('prices the MVP products as specified', () => {
    expect(getProduct('PCNWATCH_DEFENCE')?.pricePence).toBe(599);
    expect(getProduct('PCNWATCH_REJECTION_REVIEW')?.pricePence).toBe(499);
    expect(getProduct('PCNWATCH_APPEAL_PACK')?.pricePence).toBe(999);
  });

  it('keeps prices in one place, expressed in pence as integers', () => {
    for (const product of PRODUCTS) {
      expect(Number.isInteger(product.pricePence)).toBe(true);
      expect(product.pricePence).toBeGreaterThan(0);
      expect(product.currency).toBe('GBP');
    }
  });

  it('resolves entitlements from purchased SKUs', () => {
    const granted = entitlementsFor(['PCNWATCH_DEFENCE']);
    expect(granted.has('CHALLENGE_DRAFT')).toBe(true);
    expect(granted.has('EXPORT_PDF')).toBe(true);
    expect(granted.has('APPEAL_BUNDLE')).toBe(false);
  });

  it('ignores an unknown SKU rather than granting anything', () => {
    expect(entitlementsFor(['NOT_A_PRODUCT']).size).toBe(0);
  });
});

describe('webhook signature verification', () => {
  it('accepts a correctly signed body', () => {
    const body = JSON.stringify(completedSession());
    expect(verifyWebhookSignature(body, sign(body), SECRET, NOW).valid).toBe(true);
  });

  it('rejects a body that has been altered after signing', () => {
    const body = JSON.stringify(completedSession());
    const signature = sign(body);
    const tampered = body.replace('"amount_total":599', '"amount_total":1');
    expect(verifyWebhookSignature(tampered, signature, SECRET, NOW).valid).toBe(false);
  });

  it('rejects a signature made with a different secret', () => {
    const body = JSON.stringify(completedSession());
    const signature = sign(body, NOW, 'whsec_wrong_secret');
    expect(verifyWebhookSignature(body, signature, SECRET, NOW).valid).toBe(false);
  });

  it('rejects a missing signature header', () => {
    const result = verifyWebhookSignature('{}', null, SECRET, NOW);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('No signature');
  });

  it('rejects a malformed signature header', () => {
    expect(verifyWebhookSignature('{}', 'nonsense', SECRET, NOW).valid).toBe(false);
    expect(verifyWebhookSignature('{}', 't=123', SECRET, NOW).valid).toBe(false);
  });

  it('rejects a replayed signature outside the tolerance window', () => {
    const body = JSON.stringify(completedSession());
    const oldTimestamp = NOW - WEBHOOK_TOLERANCE_SECONDS - 1;
    const result = verifyWebhookSignature(body, sign(body, oldTimestamp), SECRET, NOW);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('outside the accepted window');
  });

  it('accepts a signature inside the tolerance window', () => {
    const body = JSON.stringify(completedSession());
    const recent = NOW - WEBHOOK_TOLERANCE_SECONDS + 10;
    expect(verifyWebhookSignature(body, sign(body, recent), SECRET, NOW).valid).toBe(true);
  });
});

describe('event interpretation', () => {
  it('accepts a completed, paid session for a known product', () => {
    const result = interpretCheckoutEvent(completedSession());
    expect(result.kind).toBe('COMPLETED');
    if (result.kind !== 'COMPLETED') return;
    expect(result.checkout.productSku).toBe('PCNWATCH_DEFENCE');
    expect(result.checkout.amountPence).toBe(599);
  });

  it('ignores an event type that does not represent a completed payment', () => {
    const result = interpretCheckoutEvent({ type: 'checkout.session.expired', data: { object: {} } });
    expect(result.kind).toBe('IGNORED');
  });

  it('ignores a session that has not actually been paid', () => {
    const result = interpretCheckoutEvent(completedSession({ payment_status: 'unpaid' }));
    expect(result.kind).toBe('IGNORED');
    if (result.kind !== 'IGNORED') return;
    expect(result.reason).toContain('not "paid"');
  });

  it('rejects a session that paid less than the product costs', () => {
    const result = interpretCheckoutEvent(completedSession({ amount_total: 1 }));
    expect(result.kind).toBe('INVALID');
    if (result.kind !== 'INVALID') return;
    expect(result.reason).toContain('less than the price');
  });

  it('rejects a session naming a product that does not exist', () => {
    const result = interpretCheckoutEvent(
      completedSession({
        metadata: { user_id: 'u', product_sku: 'PCNWATCH_FREE_MONEY' },
      }),
    );
    expect(result.kind).toBe('INVALID');
  });

  it('rejects a session with no user in its metadata', () => {
    const result = interpretCheckoutEvent(
      completedSession({ metadata: { product_sku: 'PCNWATCH_DEFENCE' } }),
    );
    expect(result.kind).toBe('INVALID');
  });

  it('rejects a non-object event', () => {
    for (const bad of [null, 'string', 42]) {
      expect(interpretCheckoutEvent(bad).kind).toBe('INVALID');
    }
  });
});

describe('checkout return page', () => {
  it('grants nothing from its query parameters', () => {
    const params = new URLSearchParams({
      case: '55555555-5555-5555-5555-555555555555',
      success: 'true',
      paid: 'true',
      entitlement: 'CHALLENGE_DRAFT',
      session_id: 'cs_test_123',
    });
    const result = interpretCheckoutReturn(params);
    expect(result.grantsAnything).toBe(false);
    expect(result.caseId).toBe('55555555-5555-5555-5555-555555555555');
  });

  it('ignores a malformed case identifier', () => {
    const result = interpretCheckoutReturn(new URLSearchParams({ case: '../../etc/passwd' }));
    expect(result.caseId).toBeNull();
  });

  it('has no code path that returns a granted entitlement from a redirect', () => {
    const source = interpretCheckoutReturn.toString();
    expect(source).not.toMatch(/grantsAnything:\s*true/);
  });
});
