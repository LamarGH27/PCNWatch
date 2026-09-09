import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Where Stripe sends the user back to.
 *
 * A Checkout Session created on the Preview deployment carried the Production
 * domain, because the return origin was read from `NEXT_PUBLIC_SITE_URL` — a
 * variable that is deliberately the canonical public domain in every
 * environment, since `robots.txt`, `sitemap.xml` and `metadataBase` all want
 * it that way. A Sandbox payment would have returned a customer to Production,
 * where their session cookie does not exist and the case they had just paid
 * for could not be found.
 *
 * These cover the resolver's branches, the route's real output, and the two
 * things that must never influence either: the request body and the request
 * headers.
 */

const state = vi.hoisted(() => ({
  user: null as { id: string; email?: string } | null,
  db: {} as Record<string, Record<string, unknown>[]>,
  env: {} as Record<string, string | undefined>,
  flags: { payments: true, defencePackPreview: false },
  siteUrl: 'https://pcnwatch.vercel.app',
  stripeBodies: [] as string[],
}));

/** Minimal stand-in: this suite is about one string, not about persistence. */
class Q {
  private op = 'select';
  private payload: Record<string, unknown> | null = null;
  private filters: { c: string; v: unknown }[] = [];
  constructor(private readonly table: string, private readonly forced: { c: string; v: unknown }[] = []) {}
  select() { return this; }
  eq(c: string, v: unknown) { this.filters.push({ c, v }); return this; }
  in() { return this; }
  order() { return this; }
  limit() { return this; }
  insert(p: Record<string, unknown>) { this.op = 'insert'; this.payload = p; return this; }
  upsert(p: Record<string, unknown>) { this.op = 'upsert'; this.payload = p; return this; }
  update(p: Record<string, unknown>) { this.op = 'update'; this.payload = p; return this; }
  delete() { this.op = 'delete'; return this; }
  private rows() { return (state.db[this.table] ??= []); }
  private matched() {
    const all = [...this.filters, ...this.forced];
    return this.rows().filter((row) => all.every((f) => row[f.c] === f.v));
  }
  private run(): { data: Record<string, unknown>[]; error: unknown } {
    if (this.op === 'select') return { data: this.matched(), error: null };
    if (this.op === 'insert' || this.op === 'upsert') {
      const stored = { id: `row-${this.rows().length + 1}`, ...(this.payload ?? {}) };
      this.rows().push(stored);
      return { data: [stored], error: null };
    }
    return { data: [], error: null };
  }
  async maybeSingle() { const r = this.run(); return { data: r.data[0] ?? null, error: r.error }; }
  async single() { const r = this.run(); return { data: r.data[0] ?? null, error: r.error }; }
  then(resolve: (v: { data: Record<string, unknown>[]; error: unknown }) => void) { resolve(this.run()); }
}

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: state.user } }) },
    from: (t: string) => (t === 'pcn_cases' ? new Q(t, [{ c: 'user_id', v: state.user?.id }]) : new Q(t)),
  }),
  createSupabaseServiceClient: () => ({ from: (t: string) => new Q(t) }),
}));

vi.mock('@/lib/env', () => ({
  serverEnv: () => state.env,
  isConfigured: () => true,
  get publicEnv() { return { NEXT_PUBLIC_SITE_URL: state.siteUrl }; },
  featureFlags: state.flags,
}));

vi.mock('@/server/rate-limit', () => ({
  rateLimit: async () => ({ allowed: true, remaining: 10, retryAfterSeconds: 0 }),
}));

import { POST as checkout } from '@/app/api/checkout/route';
import { resolveCheckoutOrigin, checkoutReturnUrls } from '@/server/payments/origin';

const USER = '11111111-1111-1111-1111-111111111111';
const CASE = '55555555-5555-5555-5555-555555555555';
const PREVIEW_HOST = 'pcn-watch-ha1vxpxnc-lamargh27s-projects.vercel.app';
const PRODUCTION = 'https://pcnwatch.vercel.app';

function req(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://pcnwatch.vercel.app/api/checkout', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

/** The success_url Stripe was actually asked for. */
async function sentUrls() {
  const sent = new URLSearchParams(state.stripeBodies[0] ?? '');
  return { success: sent.get('success_url') ?? '', cancel: sent.get('cancel_url') ?? '' };
}

beforeEach(() => {
  state.user = { id: USER, email: 'user@example.test' };
  state.db = {
    pcn_cases: [{ id: CASE, user_id: USER }],
    products: [{ id: 'prod-1', sku: 'PCNWATCH_DEFENCE' }],
    payments: [],
    entitlements: [],
  };
  state.flags.payments = true;
  state.siteUrl = PRODUCTION;
  state.stripeBodies = [];
  state.env = {
    STRIPE_SECRET_KEY: 'sk_test_abc',
    STRIPE_WEBHOOK_SECRET: 'whsec_abc',
    STRIPE_DEFENCE_PACK_PRICE_ID: 'price_abc',
  };
  process.env.STRIPE_DEFENCE_PACK_PRICE_ID = 'price_abc';
  delete process.env.VERCEL_ENV;
  delete process.env.VERCEL_URL;
  delete process.env.CHECKOUT_RETURN_ORIGIN;

  vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
    state.stripeBodies.push(typeof init?.body === 'string' ? init.body : String(init?.body ?? ''));
    if (String(url).includes('/checkout/sessions')) {
      return new Response(
        JSON.stringify({ id: 'cs_1', url: 'https://checkout.stripe.test/1', expires_at: 1 }),
        { status: 200 },
      );
    }
    return new Response('{}', { status: 404 });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.VERCEL_ENV;
  delete process.env.VERCEL_URL;
  delete process.env.CHECKOUT_RETURN_ORIGIN;
});

/* ------------------------------------------------------------------ */

describe('1 + 2. Preview returns to Preview', () => {
  beforeEach(() => {
    process.env.VERCEL_ENV = 'preview';
    process.env.VERCEL_URL = PREVIEW_HOST;
  });

  it('produces a Preview success URL', async () => {
    await checkout(req({ caseId: CASE }));
    const { success } = await sentUrls();
    expect(success).toBe(`https://${PREVIEW_HOST}/case/${CASE}/defence?checkout=returned`);
    // The regression: NEXT_PUBLIC_SITE_URL is still Production, and is no
    // longer what a Preview deployment sends Stripe.
    expect(success).not.toContain('pcnwatch.vercel.app/case');
  });

  it('produces a Preview cancel URL', async () => {
    await checkout(req({ caseId: CASE }));
    const { cancel } = await sentUrls();
    expect(cancel).toBe(`https://${PREVIEW_HOST}/case/${CASE}/defence?checkout=cancelled`);
    expect(cancel).not.toContain('pcnwatch.vercel.app/case');
  });

  it('refuses rather than guessing when Vercel names no deployment URL', async () => {
    delete process.env.VERCEL_URL;
    const response = await checkout(req({ caseId: CASE }));
    expect(response.status).toBe(503);
    expect(state.stripeBodies).toHaveLength(0);
  });
});

describe('3. Production returns to Production', () => {
  it('uses the canonical domain, not the deployment URL', async () => {
    process.env.VERCEL_ENV = 'production';
    process.env.VERCEL_URL = 'pcn-watch-somehash-lamargh27s-projects.vercel.app';
    // Production runs on live keys. With test keys the mode guard refuses
    // before a session is ever created, which is its own separate promise.
    state.env.STRIPE_SECRET_KEY = 'sk_live_abc';
    await checkout(req({ caseId: CASE }));
    const { success, cancel } = await sentUrls();
    expect(success).toBe(`${PRODUCTION}/case/${CASE}/defence?checkout=returned`);
    expect(cancel).toBe(`${PRODUCTION}/case/${CASE}/defence?checkout=cancelled`);
    expect(success).not.toContain('somehash');
  });
});

describe('4. The client cannot choose where it comes back to', () => {
  it('ignores every return URL field a caller might invent', async () => {
    process.env.VERCEL_ENV = 'preview';
    process.env.VERCEL_URL = PREVIEW_HOST;

    await checkout(
      req({
        caseId: CASE,
        successUrl: 'https://attacker.example/steal',
        success_url: 'https://attacker.example/steal',
        cancelUrl: 'https://attacker.example/steal',
        cancel_url: 'https://attacker.example/steal',
        returnUrl: 'https://attacker.example/steal',
        redirectUri: 'https://attacker.example/steal',
        origin: 'https://attacker.example',
        baseUrl: 'https://attacker.example',
      }),
    );

    const { success, cancel } = await sentUrls();
    expect(success).toBe(`https://${PREVIEW_HOST}/case/${CASE}/defence?checkout=returned`);
    expect(cancel).toBe(`https://${PREVIEW_HOST}/case/${CASE}/defence?checkout=cancelled`);
    expect(state.stripeBodies[0]).not.toContain('attacker.example');
  });

  it('reads exactly one field out of the request body', () => {
    const source = readFileSync('src/app/api/checkout/route.ts', 'utf8');
    const reads = [...source.matchAll(/body\.(\w+)/g)].map((m) => m[1]);
    expect(new Set(reads)).toEqual(new Set(['caseId']));
  });
});

describe('5. Hostile headers cannot redirect Stripe elsewhere', () => {
  it('ignores Host, X-Forwarded-Host, Origin and Referer', async () => {
    process.env.VERCEL_ENV = 'preview';
    process.env.VERCEL_URL = PREVIEW_HOST;

    await checkout(
      req(
        { caseId: CASE },
        {
          host: 'attacker.example',
          'x-forwarded-host': 'attacker.example',
          'x-forwarded-proto': 'http',
          origin: 'https://attacker.example',
          referer: 'https://attacker.example/pay',
          'x-vercel-deployment-url': 'attacker.example',
        },
      ),
    );

    const { success, cancel } = await sentUrls();
    expect(success).toBe(`https://${PREVIEW_HOST}/case/${CASE}/defence?checkout=returned`);
    expect(cancel).toBe(`https://${PREVIEW_HOST}/case/${CASE}/defence?checkout=cancelled`);
    expect(state.stripeBodies[0]).not.toContain('attacker.example');
  });

  it('has no code path that could read a host from a request', () => {
    for (const file of ['src/app/api/checkout/route.ts', 'src/server/payments/origin.ts']) {
      const source = readFileSync(file, 'utf8');
      const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
      expect(code, `in ${file}`).not.toMatch(/headers\s*\.\s*get/);
      expect(code, `in ${file}`).not.toMatch(/\brequest\.url\b|nextUrl|searchParams|referer|x-forwarded/i);
    }
  });
});

describe('6. The case id survives into both URLs', () => {
  it('carries the id, encoded, in success and cancel alike', async () => {
    process.env.VERCEL_ENV = 'preview';
    process.env.VERCEL_URL = PREVIEW_HOST;
    await checkout(req({ caseId: CASE }));
    const { success, cancel } = await sentUrls();

    for (const url of [success, cancel]) {
      const parsed = new URL(url);
      expect(parsed.pathname).toBe(`/case/${CASE}/defence`);
      expect(parsed.host).toBe(PREVIEW_HOST);
    }
    expect(new URL(success).searchParams.get('checkout')).toBe('returned');
    expect(new URL(cancel).searchParams.get('checkout')).toBe('cancelled');
  });

  it('escapes anything that could open a path of its own', () => {
    // The route validates the id as a uuid long before this, so this pins the
    // builder rather than the route: no caller may put a separator in a URL.
    const { successUrl } = checkoutReturnUrls('https://preview.test', '../../evil?x=1');
    expect(successUrl).toBe('https://preview.test/case/..%2F..%2Fevil%3Fx%3D1/defence?checkout=returned');
    expect(new URL(successUrl).pathname).toBe('/case/..%2F..%2Fevil%3Fx%3D1/defence');
  });
});

/* ------------------------------------------------------------------ */

describe('the resolver, branch by branch', () => {
  const base = { siteUrl: PRODUCTION, configured: undefined, vercelUrl: undefined };

  it('prefers an explicitly configured origin everywhere', () => {
    for (const vercelEnv of ['production', 'preview', 'development', undefined]) {
      const verdict = resolveCheckoutOrigin({
        ...base, vercelEnv, vercelUrl: PREVIEW_HOST, configured: 'https://pinned.example',
      });
      expect(verdict).toEqual({ ok: true, origin: 'https://pinned.example', source: 'CONFIGURED' });
    }
  });

  it('falls back to the site URL off Vercel', () => {
    expect(resolveCheckoutOrigin({ ...base, vercelEnv: undefined }))
      .toEqual({ ok: true, origin: PRODUCTION, source: 'SITE_URL' });
    expect(resolveCheckoutOrigin({ ...base, vercelEnv: 'development' }))
      .toEqual({ ok: true, origin: PRODUCTION, source: 'SITE_URL' });
  });

  it('allows http only for localhost', () => {
    expect(resolveCheckoutOrigin({ ...base, vercelEnv: undefined, siteUrl: 'http://localhost:3000' }).ok).toBe(true);
    expect(resolveCheckoutOrigin({ ...base, vercelEnv: undefined, siteUrl: 'http://pcnwatch.vercel.app' }).ok).toBe(false);
  });

  it('refuses a deployment environment Vercel has not invented yet', () => {
    const verdict = resolveCheckoutOrigin({ ...base, vercelEnv: 'staging', vercelUrl: PREVIEW_HOST });
    expect(verdict.ok).toBe(false);
  });

  it('refuses an origin carrying a path, query, fragment or credentials', () => {
    for (const bad of [
      'https://x.example/app',
      'https://x.example/?a=1',
      'https://x.example/#f',
      'https://user:pw@x.example',
      'not a url',
    ]) {
      expect(resolveCheckoutOrigin({ ...base, vercelEnv: undefined, siteUrl: bad }).ok, bad).toBe(false);
    }
  });

  it('accepts a trailing slash, which is how people write a site URL', () => {
    expect(resolveCheckoutOrigin({ ...base, vercelEnv: undefined, siteUrl: 'https://x.example/' }))
      .toEqual({ ok: true, origin: 'https://x.example', source: 'SITE_URL' });
  });
});

describe('Stripe diagnostics say why, without saying too much', () => {
  it('records the error envelope and the request id, and no secret', async () => {
    process.env.VERCEL_ENV = 'preview';
    process.env.VERCEL_URL = PREVIEW_HOST;

    // The real first failure: a recurring Price against a payment-mode session.
    vi.stubGlobal('fetch', async (_url: string | URL, init?: RequestInit) => {
      state.stripeBodies.push(typeof init?.body === 'string' ? init.body : '');
      return new Response(
        JSON.stringify({
          error: {
            type: 'invalid_request_error',
            code: 'parameter_invalid',
            param: 'line_items[0][price]',
            message: 'You specified payment mode but passed a recurring price.',
          },
        }),
        { status: 400, headers: { 'request-id': 'req_AUDIT123' } },
      );
    });

    const logged: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((line) => { logged.push(String(line)); });
    const response = await checkout(req({ caseId: CASE }));
    spy.mockRestore();

    expect(response.status).toBe(503);
    const line = logged.find((l) => l.includes('stripe.api'));
    expect(line, 'no stripe.api diagnostic was logged').toBeDefined();

    const entry = JSON.parse(line as string) as Record<string, unknown>;
    expect(entry.stripeType).toBe('invalid_request_error');
    expect(entry.stripeCode).toBe('parameter_invalid');
    expect(entry.stripeParam).toBe('line_items[0][price]');
    expect(entry.status).toBe(400);
    expect(entry.stripeRequestId).toBe('req_AUDIT123');

    /*
     * The diagnostic itself carries the envelope and nothing else — not even
     * the case id, which the route's own catch line does log for support
     * correlation. An opaque uuid is not PCN contents; Stripe's prose is
     * fetched from the dashboard by request id rather than copied here.
     */
    expect(Object.keys(entry).sort()).toEqual([
      'correlationId', 'level', 'message', 'operation', 'scope', 'stack', 'status',
      'stripeCode', 'stripeDeclineCode', 'stripeParam', 'stripeRequestId', 'stripeType',
    ]);

    // No key, no secret, and no Stripe prose, in any line the request produced.
    for (const written of logged) {
      expect(written).not.toContain('sk_test_abc');
      expect(written).not.toContain('sk_live_abc');
      expect(written).not.toContain('whsec_abc');
      expect(written).not.toContain('You specified payment mode');
    }
  });
});
