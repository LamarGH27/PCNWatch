import { createHmac, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Stripe Checkout, end to end, against a database stand-in that enforces the
 * constraints the real one does.
 *
 * The invariants being defended are commercial rather than cosmetic:
 *
 *   * the browser cannot choose what it pays or what it gets;
 *   * a redirect back from Stripe grants nothing;
 *   * a repeated webhook grants nothing twice;
 *   * a webhook we failed to process is retried rather than swallowed;
 *   * no case detail ever reaches Stripe;
 *   * Live keys cannot run outside Production, and Test keys cannot run in it.
 *
 * Several of these are only meaningful if the stand-in refuses what Postgres
 * refuses, so it carries the unique constraints and the
 * `payments_paid_requires_webhook` CHECK from the migrations.
 */

type Row = Record<string, unknown>;

const UNIQUE: Record<string, readonly string[][]> = {
  stripe_events: [['id']],
  payments: [['stripe_checkout_session_id']],
  entitlements: [['user_id', 'case_id', 'entitlement']],
};

const state = vi.hoisted(() => ({
  user: null as { id: string; email?: string } | null,
  db: {} as Record<string, Row[]>,
  /** Makes every write to this table fail, to exercise the recovery paths. */
  failTable: null as string | null,
  seq: 0,
  env: {} as Record<string, string | undefined>,
  flags: { payments: true, defencePackPreview: false },
  stripeCalls: [] as { url: string; body: string; idempotencyKey: string | null }[],
  sessionCounter: 0,
  sessionExpiresAt: null as number | null,
}));

class Q {
  private op: 'select' | 'insert' | 'upsert' | 'update' | 'delete' = 'select';
  private payload: Row | Row[] | null = null;
  private conflict: string | null = null;
  private ignoreDuplicates = false;
  private filters: { c: string; o: 'eq' | 'in' | 'is'; v: unknown }[] = [];
  private orderCol: string | null = null;
  private orderAsc = true;
  private limitN: number | null = null;

  constructor(private readonly table: string, forced: { c: string; v: unknown }[] = []) {
    for (const f of forced) this.filters.push({ c: f.c, o: 'eq', v: f.v });
  }

  select() { return this; }
  eq(c: string, v: unknown) { this.filters.push({ c, o: 'eq', v }); return this; }
  in(c: string, v: unknown[]) { this.filters.push({ c, o: 'in', v }); return this; }
  is(c: string, v: unknown) { this.filters.push({ c, o: 'is', v }); return this; }
  order(c: string, opts?: { ascending?: boolean }) {
    this.orderCol = c;
    this.orderAsc = opts?.ascending !== false;
    return this;
  }
  limit(n: number) { this.limitN = n; return this; }
  insert(p: Row | Row[]) { this.op = 'insert'; this.payload = p; return this; }
  upsert(p: Row | Row[], opts?: { onConflict?: string; ignoreDuplicates?: boolean }) {
    this.op = 'upsert';
    this.payload = p;
    this.conflict = opts?.onConflict ?? null;
    this.ignoreDuplicates = opts?.ignoreDuplicates === true;
    return this;
  }
  update(p: Row) { this.op = 'update'; this.payload = p; return this; }
  delete() { this.op = 'delete'; return this; }

  async maybeSingle() {
    const r = this.run();
    return { data: r.error ? null : (r.data[0] ?? null), error: r.error };
  }
  async single() {
    const r = this.run();
    if (r.error) return { data: null, error: r.error };
    if (r.data.length === 0) return { data: null, error: { code: 'PGRST116', message: 'no rows' } };
    return { data: r.data[0], error: null };
  }
  then(resolve: (v: { data: Row[]; error: unknown }) => void) { resolve(this.run()); }

  private rows(): Row[] { return (state.db[this.table] ??= []); }

  private matches(row: Row): boolean {
    return this.filters.every((f) => {
      if (f.o === 'eq') return row[f.c] === f.v;
      if (f.o === 'in') return (f.v as unknown[]).includes(row[f.c]);
      return f.v === null ? row[f.c] === null || row[f.c] === undefined : row[f.c] === f.v;
    });
  }

  /** The constraints from 0005 and 0020, so the fake refuses what Postgres does. */
  private violation(candidate: Row, ignoreSelf?: Row): unknown {
    if (this.table === 'payments' && candidate.status === 'PAID' && !candidate.confirmed_by_webhook_at) {
      return { code: '23514', message: 'payments_paid_requires_webhook' };
    }
    for (const cols of UNIQUE[this.table] ?? []) {
      if (cols.some((c) => candidate[c] === null || candidate[c] === undefined)) continue;
      const clash = this.rows().find(
        (row) => row !== ignoreSelf && cols.every((c) => row[c] === candidate[c]),
      );
      if (clash) return { code: '23505', message: `duplicate key value violates unique constraint on ${cols.join(',')}` };
    }
    return null;
  }

  private run(): { data: Row[]; error: unknown } {
    if (state.failTable === this.table && this.op !== 'select') {
      return { data: [], error: { code: 'XXXXX', message: 'injected failure' } };
    }
    const rows = this.rows();

    if (this.op === 'select') {
      let found = rows.filter((row) => this.matches(row));
      if (this.orderCol) {
        const col = this.orderCol;
        found = [...found].sort((a, b) =>
          this.orderAsc
            ? String(a[col]).localeCompare(String(b[col]))
            : String(b[col]).localeCompare(String(a[col])),
        );
      }
      if (this.limitN !== null) found = found.slice(0, this.limitN);
      return { data: found, error: null };
    }

    if (this.op === 'insert' || this.op === 'upsert') {
      const incoming = Array.isArray(this.payload) ? this.payload : [this.payload as Row];
      const written: Row[] = [];
      for (const row of incoming) {
        const conflictCols = this.conflict?.split(',').map((c) => c.trim()) ?? [];
        const existing =
          this.op === 'upsert' && conflictCols.length > 0
            ? rows.find((candidate) => conflictCols.every((c) => candidate[c] === row[c]))
            : undefined;

        if (existing) {
          if (this.ignoreDuplicates) { written.push(existing); continue; }
          const merged = { ...existing, ...row };
          const bad = this.violation(merged, existing);
          if (bad) return { data: [], error: bad };
          Object.assign(existing, row);
          written.push(existing);
          continue;
        }

        const stored: Row = {
          id: row.id ?? randomUUID(),
          created_at: new Date(1_800_000_000_000 + state.seq++).toISOString(),
          ...row,
        };
        const bad = this.violation(stored);
        if (bad) return { data: [], error: bad };
        rows.push(stored);
        written.push(stored);
      }
      return { data: written, error: null };
    }

    if (this.op === 'update') {
      const touched = rows.filter((row) => this.matches(row));
      for (const row of touched) {
        const merged = { ...row, ...(this.payload as Row) };
        const bad = this.violation(merged, row);
        if (bad) return { data: [], error: bad };
        Object.assign(row, this.payload as Row);
      }
      return { data: touched, error: null };
    }

    const kept = rows.filter((row) => !this.matches(row));
    const removed = rows.filter((row) => this.matches(row));
    state.db[this.table] = kept;
    return { data: removed, error: null };
  }
}

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: state.user } }) },
    // The user-scoped client sees only its own cases, which is what RLS does.
    from: (table: string) =>
      table === 'pcn_cases'
        ? new Q(table, [{ c: 'user_id', v: state.user?.id }])
        : new Q(table, []),
  }),
  createSupabaseServiceClient: () => ({ from: (table: string) => new Q(table) }),
}));

vi.mock('@/lib/env', () => ({
  serverEnv: () => state.env,
  isConfigured: (name: string) =>
    name === 'stripe'
      ? Boolean(state.env.STRIPE_SECRET_KEY && state.env.STRIPE_WEBHOOK_SECRET && state.env.STRIPE_DEFENCE_PACK_PRICE_ID)
      : true,
  publicEnv: { NEXT_PUBLIC_SITE_URL: 'https://preview.example.test' },
  featureFlags: state.flags,
}));

vi.mock('@/server/rate-limit', () => ({
  rateLimit: async () => ({ allowed: true, remaining: 10, retryAfterSeconds: 0 }),
}));

import { POST as checkout } from '@/app/api/checkout/route';
import { POST as webhook } from '@/app/api/stripe/webhook/route';
import { GET as entitlementRoute } from '@/app/api/cases/[id]/entitlement/route';
import { checkStripeMode, stripeModeFromKey } from '@/server/payments/mode';

const USER = '11111111-1111-1111-1111-111111111111';
const OTHER_USER = '22222222-2222-2222-2222-222222222222';
const CASE = '55555555-5555-5555-5555-555555555555';
const WEBHOOK_SECRET = 'whsec_test_secret';
const PRICE_ID = 'price_test_defence';

function checkoutRequest(body: unknown): Request {
  return new Request('https://preview.example.test/api/checkout', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function signedWebhook(event: unknown, secret = WEBHOOK_SECRET): Request {
  const raw = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
  return new Request('https://preview.example.test/api/stripe/webhook', {
    method: 'POST',
    headers: { 'stripe-signature': `t=${t},v1=${v1}` },
    body: raw,
  });
}

function completedEvent(overrides: Row = {}, sessionOverrides: Row = {}) {
  return {
    id: 'evt_completed_1',
    type: 'checkout.session.completed',
    livemode: false,
    data: {
      object: {
        id: 'cs_test_1',
        payment_status: 'paid',
        payment_intent: 'pi_test_1',
        amount_total: 599,
        currency: 'gbp',
        metadata: { user_id: USER, case_id: CASE, product_sku: 'PCNWATCH_DEFENCE' },
        ...sessionOverrides,
      },
    },
    ...overrides,
  };
}

/** The table, created on demand, without an index check at every use site. */
function table(name: string): Row[] {
  return (state.db[name] ??= []);
}
function first<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error('Expected at least one row.');
  return row;
}

function paymentsFor(caseId = CASE): Row[] {
  return (table('payments') ?? []).filter((row) => row.case_id === caseId);
}
function entitlementsFor(caseId = CASE): Row[] {
  return (state.db.entitlements ?? []).filter((row) => row.case_id === caseId);
}

beforeEach(() => {
  state.user = { id: USER, email: 'user@example.test' };
  state.db = {
    pcn_cases: [
      { id: CASE, user_id: USER },
      { id: '99999999-9999-9999-9999-999999999999', user_id: OTHER_USER },
    ],
    products: [{ id: 'prod-row-1', sku: 'PCNWATCH_DEFENCE' }],
    payments: [],
    entitlements: [],
    stripe_events: [],
    audit_events: [],
  };
  state.failTable = null;
  state.seq = 0;
  state.sessionCounter = 0;
  state.sessionExpiresAt = null;
  state.stripeCalls = [];
  state.flags.payments = true;
  state.flags.defencePackPreview = false;
  state.env = {
    STRIPE_SECRET_KEY: 'sk_test_abc',
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    STRIPE_DEFENCE_PACK_PRICE_ID: PRICE_ID,
  };
  process.env.STRIPE_DEFENCE_PACK_PRICE_ID = PRICE_ID;
  delete process.env.VERCEL_ENV;

  vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    const body = typeof init?.body === 'string' ? init.body : String(init?.body ?? '');
    const headers = new Headers(init?.headers as HeadersInit);
    state.stripeCalls.push({ url: href, body, idempotencyKey: headers.get('idempotency-key') });

    if (href.includes('/checkout/sessions')) {
      state.sessionCounter += 1;
      return new Response(
        JSON.stringify({
          id: `cs_live_stub_${state.sessionCounter}`,
          url: `https://checkout.stripe.test/${state.sessionCounter}`,
          expires_at: state.sessionExpiresAt ?? Math.floor(Date.now() / 1000) + 86_400,
        }),
        { status: 200 },
      );
    }
    if (href.includes('/payment_intents/')) {
      return new Response(JSON.stringify({ latest_charge: 'ch_test_1' }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------------ */

describe('checkout: the browser does not choose what it pays for', () => {
  it('ignores an amount, product and entitlement supplied by the caller', async () => {
    const response = await checkout(
      checkoutRequest({
        caseId: CASE,
        // Everything a hostile client might hope is read.
        sku: 'PCNWATCH_APPEAL_PACK',
        productSku: 'PCNWATCH_APPEAL_PACK',
        amountPence: 1,
        price: 1,
        currency: 'usd',
        entitlement: 'APPEAL_BUNDLE',
        entitlements: ['APPEAL_BUNDLE'],
      }),
    );
    const result = (await response.json()) as { ok: boolean; url?: string };
    expect(result.ok).toBe(true);

    const call = first(state.stripeCalls);
    const sent = new URLSearchParams(call.body);
    expect(sent.get('line_items[0][price]')).toBe(PRICE_ID);
    expect(sent.get('metadata[product_sku]')).toBe('PCNWATCH_DEFENCE');
    // No amount is transmitted at all: the Price fixes it in the dashboard.
    expect(call.body).not.toMatch(/amount/i);
    expect(call.body).not.toMatch(/APPEAL/);

    const row = first(paymentsFor());
    expect(row.amount_pence).toBe(599);
    expect(row.currency).toBe('GBP');
    expect(row.status).toBe('PENDING');
    // Recorded from what was sent, not re-read from configuration afterwards.
    expect(row.stripe_price_id).toBe(PRICE_ID);
  });

  it('reads no price, product or entitlement out of the request body', async () => {
    const source = (await import('node:fs')).readFileSync('src/app/api/checkout/route.ts', 'utf8');
    const bodyReads = [...source.matchAll(/body\.(\w+)/g)].map((m) => m[1]);
    expect(new Set(bodyReads)).toEqual(new Set(['caseId']));
  });

  it('never writes a PAID row from the checkout path', async () => {
    await checkout(checkoutRequest({ caseId: CASE }));
    expect(paymentsFor().every((row) => row.status === 'PENDING')).toBe(true);
    expect(paymentsFor().every((row) => !row.confirmed_by_webhook_at)).toBe(true);
    expect(entitlementsFor()).toHaveLength(0);
  });

  it('refuses a case the caller does not own, without reaching Stripe', async () => {
    const response = await checkout(
      checkoutRequest({ caseId: '99999999-9999-9999-9999-999999999999' }),
    );
    expect(response.status).toBe(404);
    expect(state.stripeCalls).toHaveLength(0);
    expect(table('payments')).toHaveLength(0);
  });

  it('refuses when the caller is not signed in', async () => {
    state.user = null;
    const response = await checkout(checkoutRequest({ caseId: CASE }));
    expect(response.status).toBe(401);
    expect(state.stripeCalls).toHaveLength(0);
  });

  it('refuses when payments are not enabled on the deployment', async () => {
    state.flags.payments = false;
    const response = await checkout(checkoutRequest({ caseId: CASE }));
    expect(response.status).toBe(503);
    expect(state.stripeCalls).toHaveLength(0);
  });
});

describe('checkout: nothing about the case reaches Stripe', () => {
  it('sends three opaque identifiers and no case content', async () => {
    table('pcn_cases')[0] = {
      id: CASE,
      user_id: USER,
      pcn_number: 'WM77341902',
      vehicle_registration: 'AB12 CDE',
      narrative: 'I was loading outside the bakery on Marylebone High Street.',
    };
    await checkout(checkoutRequest({ caseId: CASE }));

    const sent = new URLSearchParams(first(state.stripeCalls).body);
    const metadataKeys = [...sent.keys()].filter((k) => k.startsWith('metadata['));
    expect(metadataKeys.sort()).toEqual([
      'metadata[case_id]',
      'metadata[product_sku]',
      'metadata[user_id]',
    ]);
    for (const leak of ['WM77341902', 'AB12', 'Marylebone', 'bakery', 'loading']) {
      expect(first(state.stripeCalls).body).not.toContain(leak);
    }
  });
});

describe('checkout: one attempt, one session', () => {
  it('reuses an open attempt rather than charging a double-tap twice', async () => {
    await checkout(checkoutRequest({ caseId: CASE }));
    await checkout(checkoutRequest({ caseId: CASE }));

    const sessionCalls = state.stripeCalls.filter((c) => c.url.includes('/checkout/sessions'));
    expect(paymentsFor()).toHaveLength(1);
    // Both attempts carry the same idempotency key, so Stripe returns one session.
    expect(new Set(sessionCalls.map((c) => c.idempotencyKey)).size).toBe(1);
  });

  it('opens a new attempt, with a new idempotency key, once the session has expired', async () => {
    await checkout(checkoutRequest({ caseId: CASE }));
    const firstKey = first(state.stripeCalls).idempotencyKey;

    // The user walked away and came back the next day.
    first(table('payments')).session_expires_at = new Date(Date.now() - 60_000).toISOString();
    await checkout(checkoutRequest({ caseId: CASE }));

    const keys = state.stripeCalls
      .filter((c) => c.url.includes('/checkout/sessions'))
      .map((c) => c.idempotencyKey);
    expect(paymentsFor()).toHaveLength(2);
    expect(keys[1]).not.toBe(firstKey);
  });

  it('does not offer to charge again for something already paid for', async () => {
    table('entitlements').push({
      id: 'ent-1',
      user_id: USER,
      case_id: CASE,
      entitlement: 'CHALLENGE_DRAFT',
    });
    const response = await checkout(checkoutRequest({ caseId: CASE }));
    const result = (await response.json()) as { ok: boolean; alreadyEntitled?: boolean };
    expect(result.alreadyEntitled).toBe(true);
    expect(state.stripeCalls).toHaveLength(0);
  });
});

describe('checkout: test and live keys cannot be in the wrong place', () => {
  it('reads the mode from the key rather than from a setting', () => {
    expect(stripeModeFromKey('sk_test_x')).toBe('TEST');
    expect(stripeModeFromKey('sk_live_x')).toBe('LIVE');
    expect(stripeModeFromKey('rk_live_x')).toBe('LIVE');
    expect(stripeModeFromKey(undefined)).toBe('UNKNOWN');
    expect(stripeModeFromKey('pk_live_x')).toBe('UNKNOWN');
  });

  it('refuses live keys outside production, before contacting Stripe', async () => {
    state.env.STRIPE_SECRET_KEY = 'sk_live_real';
    process.env.VERCEL_ENV = 'preview';
    const response = await checkout(checkoutRequest({ caseId: CASE }));
    expect(response.status).toBe(503);
    expect(state.stripeCalls).toHaveLength(0);
    expect(table('payments')).toHaveLength(0);
  });

  it('refuses test keys in production, where they would grant a free product', () => {
    const verdict = checkStripeMode('sk_test_abc', 'production');
    expect(verdict.allowed).toBe(false);
  });

  it('refuses a key it does not recognise at all', () => {
    expect(checkStripeMode('', 'preview').allowed).toBe(false);
    expect(checkStripeMode(undefined, 'production').allowed).toBe(false);
  });

  it('allows the combinations that are actually correct', () => {
    expect(checkStripeMode('sk_test_abc', 'preview').allowed).toBe(true);
    expect(checkStripeMode('sk_test_abc', 'development').allowed).toBe(true);
    expect(checkStripeMode('sk_live_abc', 'production').allowed).toBe(true);
  });
});

/* ------------------------------------------------------------------ */

describe('webhook: only a verified event does anything', () => {
  it('rejects an unsigned body without writing anything', async () => {
    const raw = JSON.stringify(completedEvent());
    const response = await webhook(
      new Request('https://preview.example.test/api/stripe/webhook', { method: 'POST', body: raw }),
    );
    expect(response.status).toBe(400);
    expect(table('stripe_events')).toHaveLength(0);
    expect(entitlementsFor()).toHaveLength(0);
  });

  it('rejects a body altered after signing', async () => {
    const event = completedEvent();
    const request = signedWebhook(event);
    const tampered = new Request(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(completedEvent({}, { amount_total: 1 })),
    });
    const response = await webhook(tampered);
    expect(response.status).toBe(400);
    expect(entitlementsFor()).toHaveLength(0);
  });

  it('rejects a signature made with a different secret', async () => {
    const response = await webhook(signedWebhook(completedEvent(), 'whsec_wrong'));
    expect(response.status).toBe(400);
    expect(table('stripe_events')).toHaveLength(0);
  });
});

describe('webhook: entitlement comes from here and nowhere else', () => {
  it('records the payment and grants the entitlement', async () => {
    const response = await webhook(signedWebhook(completedEvent()));
    expect(response.status).toBe(200);

    const payment = first(paymentsFor());
    expect(payment.status).toBe('PAID');
    expect(payment.confirmed_by_webhook_at).toBeTruthy();
    expect(payment.stripe_checkout_session_id).toBe('cs_test_1');
    expect(payment.livemode).toBe(false);
    expect(payment.stripe_charge_id).toBe('ch_test_1');

    expect(entitlementsFor().map((row) => row.entitlement)).toContain('CHALLENGE_DRAFT');
    expect(first(table('stripe_events')).outcome).toBe('ACTED');
  });

  it('records livemode from the event rather than from configuration', async () => {
    await webhook(signedWebhook(completedEvent({ id: 'evt_live', livemode: true })));
    expect(first(paymentsFor()).livemode).toBe(true);
  });

  it('promotes the pending attempt rather than creating a second row', async () => {
    await checkout(checkoutRequest({ caseId: CASE }));
    const sessionId = String(first(paymentsFor()).stripe_checkout_session_id);

    await webhook(signedWebhook(completedEvent({}, { id: sessionId })));

    expect(paymentsFor()).toHaveLength(1);
    expect(first(paymentsFor()).status).toBe('PAID');
    expect(first(paymentsFor()).failure_reason).toBeNull();
  });

  it('grants nothing for a session that paid less than the product costs', async () => {
    const response = await webhook(
      signedWebhook(completedEvent({ id: 'evt_cheap' }, { amount_total: 1 })),
    );
    expect(response.status).toBe(200);
    expect(entitlementsFor()).toHaveLength(0);
    expect(first(table('stripe_events')).outcome).toBe('REJECTED');
  });

  it('grants nothing for a session that has not been paid', async () => {
    await webhook(
      signedWebhook(completedEvent({ id: 'evt_unpaid' }, { payment_status: 'unpaid' })),
    );
    expect(entitlementsFor()).toHaveLength(0);
    expect(first(table('stripe_events')).outcome).toBe('IGNORED');
  });
});

describe('webhook: repeated delivery', () => {
  it('is a no-op the second time the same event arrives', async () => {
    await webhook(signedWebhook(completedEvent()));
    const response = await webhook(signedWebhook(completedEvent()));
    const result = (await response.json()) as { acted: boolean; duplicate?: boolean };

    expect(result.acted).toBe(false);
    expect(result.duplicate).toBe(true);
    expect(paymentsFor()).toHaveLength(1);
    expect(entitlementsFor().filter((r) => r.entitlement === 'CHALLENGE_DRAFT')).toHaveLength(1);
    expect(table('audit_events')).toHaveLength(1);
    expect(table('stripe_events')).toHaveLength(1);
  });

  it('grants once when two different events describe the same session', async () => {
    // `completed` and `async_payment_succeeded` are separate event ids, so the
    // event claim does not stop the second — the session id has to.
    await webhook(signedWebhook(completedEvent()));
    await webhook(
      signedWebhook(
        completedEvent({ id: 'evt_async', type: 'checkout.session.async_payment_succeeded' }),
      ),
    );

    expect(table('stripe_events')).toHaveLength(2);
    expect(paymentsFor()).toHaveLength(1);
    expect(entitlementsFor().filter((r) => r.entitlement === 'CHALLENGE_DRAFT')).toHaveLength(1);
  });

  it('releases its claim when processing fails, so the retry is not swallowed', async () => {
    state.failTable = 'entitlements';
    const first = await webhook(signedWebhook(completedEvent()));
    expect(first.status).toBe(500);
    // The claim is gone, or Stripe's retry would find the event "already done".
    expect(table('stripe_events')).toHaveLength(0);

    state.failTable = null;
    const retry = await webhook(signedWebhook(completedEvent()));
    expect(retry.status).toBe(200);
    expect(entitlementsFor().map((r) => r.entitlement)).toContain('CHALLENGE_DRAFT');
  });

  it('retries rather than acting when the event cannot be claimed at all', async () => {
    state.failTable = 'stripe_events';
    const response = await webhook(signedWebhook(completedEvent()));
    expect(response.status).toBe(500);
    expect(entitlementsFor()).toHaveLength(0);
  });
});

describe('webhook: an expired session ends the attempt and grants nothing', () => {
  it('marks the pending attempt failed', async () => {
    await checkout(checkoutRequest({ caseId: CASE }));
    const sessionId = String(first(paymentsFor()).stripe_checkout_session_id);

    const response = await webhook(
      signedWebhook({
        id: 'evt_expired',
        type: 'checkout.session.expired',
        livemode: false,
        data: { object: { id: sessionId } },
      }),
    );
    expect(response.status).toBe(200);
    expect(first(paymentsFor()).status).toBe('FAILED');
    expect(first(paymentsFor()).failure_reason).toBe('SESSION_EXPIRED');
    expect(entitlementsFor()).toHaveLength(0);
  });

  it('cannot un-pay a session that already completed', async () => {
    await webhook(signedWebhook(completedEvent()));
    await webhook(
      signedWebhook({
        id: 'evt_expired_late',
        type: 'checkout.session.expired',
        livemode: false,
        data: { object: { id: 'cs_test_1' } },
      }),
    );
    expect(first(paymentsFor()).status).toBe('PAID');
    expect(entitlementsFor().map((r) => r.entitlement)).toContain('CHALLENGE_DRAFT');
  });
});

/* ------------------------------------------------------------------ */

describe('the return from Stripe grants nothing', () => {
  const context = { params: Promise.resolve({ id: CASE }) };

  it('reports no entitlement while only a pending attempt exists', async () => {
    await checkout(checkoutRequest({ caseId: CASE }));
    const response = await entitlementRoute(new Request('https://x.test'), {
      params: Promise.resolve({ id: CASE }),
    });
    const result = (await response.json()) as { entitled: boolean; attempt: string };
    expect(result.entitled).toBe(false);
    expect(result.attempt).toBe('PENDING');
  });

  it('reports the entitlement once the webhook has confirmed it', async () => {
    await webhook(signedWebhook(completedEvent()));
    const response = await entitlementRoute(new Request('https://x.test'), context);
    const result = (await response.json()) as { entitled: boolean; via: string };
    expect(result.entitled).toBe(true);
    expect(result.via).toBe('ENTITLEMENT');
  });

  it('will not report on somebody else’s case', async () => {
    const response = await entitlementRoute(new Request('https://x.test'), {
      params: Promise.resolve({ id: '99999999-9999-9999-9999-999999999999' }),
    });
    expect(response.status).toBe(404);
  });

  it('does not let the redirect parameter unlock the pack', async () => {
    const page = (await import('node:fs')).readFileSync(
      'src/app/case/[id]/defence/page.tsx',
      'utf8',
    );
    // Access is decided by defencePackAccess. The query parameter only chooses
    // which sentence to show while the server is asked.
    expect(page).toMatch(/const access = await defencePackAccess/);
    const gate = page.slice(page.indexOf('access.granted ?'));
    expect(gate).not.toMatch(/returnState\s*===\s*'returned'\s*(\?|\|\|)/);
  });
});

describe('secrets stay on the server', () => {
  it('exposes no Stripe secret through a NEXT_PUBLIC_ variable', async () => {
    const { execSync } = await import('node:child_process');
    const hits = execSync(
      'grep -rn "NEXT_PUBLIC_[A-Z_]*STRIPE\\|NEXT_PUBLIC_[A-Z_]*SECRET\\|NEXT_PUBLIC_[A-Z_]*WEBHOOK" src .env.example || true',
      { encoding: 'utf8' },
    ).trim();
    expect(hits).toBe('');
  });

  it('hardcodes no Stripe key anywhere in the source', async () => {
    const { execSync } = await import('node:child_process');
    const hits = execSync(
      'grep -rn "sk_live_[A-Za-z0-9]\\|sk_test_[A-Za-z0-9]\\|whsec_[A-Za-z0-9]" src || true',
      { encoding: 'utf8' },
    ).trim();
    expect(hits).toBe('');
  });

  it('logs no key, session url or signature', async () => {
    const fs = await import('node:fs');
    for (const file of [
      'src/app/api/stripe/webhook/route.ts',
      'src/app/api/checkout/route.ts',
      'src/server/payments/stripe.ts',
    ]) {
      const source = fs.readFileSync(file, 'utf8');
      const logCalls = [...source.matchAll(/log(?:Error|Info)\([^;]*?\);/gs)].map((m) => m[0]);
      for (const call of logCalls) {
        expect(call, `in ${file}`).not.toMatch(/SECRET_KEY|WEBHOOK_SECRET|session\.url/);
        /*
         * Strip string literals first, so a stage name like
         * "stripe.webhook.signature" is not mistaken for the header itself.
         * What is left is the identifiers actually being logged.
         */
        const identifiers = call
          .replace(/'[^']*'|"[^"]*"|`[^`]*`/g, "''")
          // Whether a header was present is a fact about the request, not the
          // header. Everything else is the value itself.
          .replace(/Boolean\(signature\)/g, 'PRESENT');
        expect(identifiers, `in ${file}`).not.toMatch(
          /\b(signature|rawBody|priceId|customerEmail|secret)\b/,
        );
      }
    }
  });
});
