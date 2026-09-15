import { describe, expect, it } from 'vitest';
import { __resetServerEnvCache } from '@/lib/env';
import {
  attributeCheckout,
  isCollectedPayment,
  resolveScope,
  scopedCount,
  summarisePayments,
  SCOPE_SHARED_REASON,
  SCOPE_UNKNOWN_REASON,
  type PaymentRow,
} from '@/server/admin/analytics';
import { decideAdminAccess, parseAllowlist } from '@/server/admin/auth';
import {
  buildFilter,
  buildQuery,
  fetchTraffic,
  ANALYSE_ROUTE,
  DEFENCE_OFFER_ROUTE,
} from '@/server/admin/vercel-analytics';
import {
  londonDaysInWindow,
  parseWindowKey,
  resolveWindow,
  type WindowKey,
} from '@/server/admin/window';

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const LIVE_PRICE = 'price_live_defence_pack';
const TEST_PRICE = 'price_test_defence_pack';

/** A real customer payment: paid, webhook-confirmed, live, in sterling. */
function collected(overrides: Partial<PaymentRow> = {}): PaymentRow {
  return {
    status: 'PAID',
    confirmed_by_webhook_at: '2026-09-14T10:00:00.000Z',
    livemode: true,
    currency: 'GBP',
    amount_pence: 599,
    stripe_price_id: LIVE_PRICE,
    ...overrides,
  };
}

const operator = (email: string) => ({ email, isAnonymous: false, emailConfirmed: true });

/* ------------------------------------------------------------------ */
/* 1. Unauthorised users cannot reach analytics                        */
/* ------------------------------------------------------------------ */

describe('analytics access control', () => {
  const allowlist = ['ops@pcnwatch.co.uk'];

  it('denies a visitor with no session', () => {
    expect(decideAdminAccess(allowlist, null)).toEqual({
      allowed: false,
      reason: 'NOT_SIGNED_IN',
    });
  });

  it('denies an anonymous customer, which is what every ordinary user is', () => {
    expect(
      decideAdminAccess(allowlist, { email: null, isAnonymous: true, emailConfirmed: false }),
    ).toEqual({ allowed: false, reason: 'ANONYMOUS' });
  });

  it('denies an anonymous session even if it somehow carries a listed address', () => {
    /*
     * The belt to the braces. Today an anonymous Supabase user has no email, so
     * the address check would catch this anyway — but that is a property of
     * Supabase's current behaviour, not of our policy, and the policy should
     * not quietly depend on it.
     */
    expect(
      decideAdminAccess(allowlist, {
        email: 'ops@pcnwatch.co.uk',
        isAnonymous: true,
        emailConfirmed: true,
      }),
    ).toEqual({ allowed: false, reason: 'ANONYMOUS' });
  });

  it('denies a listed address that has never been confirmed', () => {
    expect(
      decideAdminAccess(allowlist, {
        email: 'ops@pcnwatch.co.uk',
        isAnonymous: false,
        emailConfirmed: false,
      }),
    ).toEqual({ allowed: false, reason: 'EMAIL_UNCONFIRMED' });
  });

  it('denies a confirmed, non-anonymous user who is not on the list', () => {
    expect(decideAdminAccess(allowlist, operator('someone@example.com'))).toEqual({
      allowed: false,
      reason: 'NOT_ON_ALLOWLIST',
    });
  });

  it('denies everyone when no allow-list is configured', () => {
    expect(decideAdminAccess(parseAllowlist(''), operator('ops@pcnwatch.co.uk'))).toEqual({
      allowed: false,
      reason: 'ALLOWLIST_EMPTY',
    });
  });

  it('allows exactly the listed operator', () => {
    expect(decideAdminAccess(allowlist, operator('OPS@PCNWatch.co.uk')).allowed).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 2 + 3. What counts as revenue, and what must never                  */
/* ------------------------------------------------------------------ */

describe('collected payments', () => {
  it('counts a webhook-confirmed Live payment in sterling', () => {
    expect(isCollectedPayment(collected())).toBe(true);
  });

  it('refuses a PAID row that no webhook confirmed', () => {
    /*
     * The database constraint already forbids this combination. The check is
     * here anyway: this module must not be the place where a future schema
     * change turns a redirect into revenue.
     */
    expect(isCollectedPayment(collected({ confirmed_by_webhook_at: null }))).toBe(false);
  });

  it('refuses a Test-mode payment, which took no money', () => {
    expect(isCollectedPayment(collected({ livemode: false }))).toBe(false);
  });

  it('refuses a payment whose mode was never recorded', () => {
    expect(isCollectedPayment(collected({ livemode: null }))).toBe(false);
  });

  it('refuses PENDING and FAILED attempts', () => {
    expect(isCollectedPayment(collected({ status: 'PENDING' }))).toBe(false);
    expect(isCollectedPayment(collected({ status: 'FAILED' }))).toBe(false);
  });

  it('refuses a currency the total is not denominated in', () => {
    expect(isCollectedPayment(collected({ currency: 'EUR' }))).toBe(false);
    expect(isCollectedPayment(collected({ currency: null }))).toBe(false);
  });

  it('accepts sterling however Stripe happens to case it', () => {
    expect(isCollectedPayment(collected({ currency: 'gbp' }))).toBe(true);
  });

  it('sums the amounts actually charged rather than multiplying by a list price', () => {
    const rows = [
      collected({ amount_pence: 599 }),
      // A price change, a discount, or simply a different product. Whatever the
      // reason, the row says what was charged and the row wins.
      collected({ amount_pence: 450 }),
      collected({ amount_pence: 599 }),
    ];
    const summary = summarisePayments([], rows, LIVE_PRICE);

    expect(summary.purchases).toBe(3);
    expect(summary.grossCollectedPence).toBe(1648);
    // The figure a count × £5.99 shortcut would have produced.
    expect(summary.grossCollectedPence).not.toBe(3 * 599);
  });

  it('excludes every non-qualifying row from both the count and the total', () => {
    const rows = [
      collected({ amount_pence: 599 }),
      collected({ status: 'PENDING', amount_pence: 599 }),
      collected({ status: 'FAILED', amount_pence: 599 }),
      collected({ livemode: false, amount_pence: 599 }),
      collected({ confirmed_by_webhook_at: null, amount_pence: 599 }),
      collected({ currency: 'USD', amount_pence: 599 }),
    ];
    const summary = summarisePayments([], rows, LIVE_PRICE);

    expect(summary.purchases).toBe(1);
    expect(summary.grossCollectedPence).toBe(599);
  });
});

/* ------------------------------------------------------------------ */
/* Checkout attribution                                                */
/* ------------------------------------------------------------------ */

describe('checkout attribution', () => {
  const pending = (overrides: Partial<PaymentRow>): PaymentRow =>
    collected({ status: 'PENDING', confirmed_by_webhook_at: null, livemode: null, ...overrides });

  it('attributes a paid Live row to Production on its own evidence', () => {
    expect(attributeCheckout(collected(), LIVE_PRICE)).toBe('PRODUCTION');
  });

  it('attributes an unpaid row by the Price it was opened against', () => {
    expect(attributeCheckout(pending({ stripe_price_id: LIVE_PRICE }), LIVE_PRICE)).toBe(
      'PRODUCTION',
    );
    expect(attributeCheckout(pending({ stripe_price_id: TEST_PRICE }), LIVE_PRICE)).toBe(
      'NON_PRODUCTION',
    );
  });

  it('refuses to attribute a row carrying neither signal', () => {
    expect(attributeCheckout(pending({ stripe_price_id: null }), LIVE_PRICE)).toBe('UNATTRIBUTED');
  });

  it('attributes nothing when the Live Price is not configured', () => {
    // Fail closed: without knowing the Live Price, a Test row and a Live row are
    // indistinguishable, and guessing would inflate the conversion denominator.
    expect(attributeCheckout(pending({ stripe_price_id: LIVE_PRICE }), undefined)).toBe(
      'UNATTRIBUTED',
    );
  });

  it('counts Production checkouts and reports the unattributable separately', () => {
    const summary = summarisePayments(
      [
        pending({ stripe_price_id: LIVE_PRICE }),
        pending({ stripe_price_id: LIVE_PRICE }),
        pending({ stripe_price_id: TEST_PRICE }),
        pending({ stripe_price_id: null }),
      ],
      [],
      LIVE_PRICE,
    );

    expect(summary.checkouts).toBe(2);
    expect(summary.checkoutsUnattributed).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* Preview contamination                                               */
/* ------------------------------------------------------------------ */

describe('Preview contamination', () => {
  it('reads the scope only from the two values that mean something', () => {
    expect(resolveScope('PRODUCTION_ONLY')).toBe('PRODUCTION_ONLY');
    expect(resolveScope('SHARED_WITH_PREVIEW')).toBe('SHARED_WITH_PREVIEW');
    expect(resolveScope(undefined)).toBe('UNKNOWN');
    expect(resolveScope('')).toBe('UNKNOWN');
    expect(resolveScope('production')).toBe('UNKNOWN');
    expect(resolveScope('yes')).toBe('UNKNOWN');
  });

  it('shows a case count only when the database is known to be Production-only', () => {
    expect(scopedCount(42, 'PRODUCTION_ONLY')).toEqual({ kind: 'VALUE', value: 42 });
  });

  it('withholds the count when Preview shares the project', () => {
    expect(scopedCount(42, 'SHARED_WITH_PREVIEW')).toEqual({
      kind: 'UNAVAILABLE',
      reason: SCOPE_SHARED_REASON,
    });
  });

  it('withholds the count when the scope has never been established', () => {
    // Unset must not read as clean. This is the whole point of the flag.
    expect(scopedCount(42, 'UNKNOWN')).toEqual({
      kind: 'UNAVAILABLE',
      reason: SCOPE_UNKNOWN_REASON,
    });
  });

  it('never lets an unavailable count masquerade as zero', () => {
    for (const scope of ['SHARED_WITH_PREVIEW', 'UNKNOWN'] as const) {
      const metric = scopedCount(0, scope);
      expect(metric.kind).toBe('UNAVAILABLE');
    }
  });
});

/* ------------------------------------------------------------------ */
/* 5. Date windows                                                     */
/* ------------------------------------------------------------------ */

describe('date windows', () => {
  it('starts Today at London midnight, not UTC midnight, during BST', () => {
    const window = resolveWindow('TODAY', new Date('2026-07-15T10:00:00Z'));
    expect(window.startUtc.toISOString()).toBe('2026-07-14T23:00:00.000Z');
  });

  it('starts Today at UTC midnight in winter, when London is UTC', () => {
    const window = resolveWindow('TODAY', new Date('2026-01-15T10:00:00Z'));
    expect(window.startUtc.toISOString()).toBe('2026-01-15T00:00:00.000Z');
  });

  it('rolls over at London midnight rather than at UTC midnight', () => {
    // 23:30 and 00:30 London, either side of the same midnight.
    const before = resolveWindow('TODAY', new Date('2026-07-15T22:30:00Z'));
    const after = resolveWindow('TODAY', new Date('2026-07-15T23:30:00Z'));
    expect(before.startUtc.toISOString()).toBe('2026-07-14T23:00:00.000Z');
    expect(after.startUtc.toISOString()).toBe('2026-07-15T23:00:00.000Z');
  });

  it('handles the day the clocks go forward', () => {
    // BST begins 01:00 UTC on 29 March 2026, so that London day still starts at
    // UTC midnight even though it is only 23 hours long.
    const window = resolveWindow('TODAY', new Date('2026-03-29T10:00:00Z'));
    expect(window.startUtc.toISOString()).toBe('2026-03-29T00:00:00.000Z');
  });

  it('spans whole London days across the spring transition', () => {
    const window = resolveWindow('LAST_7', new Date('2026-04-01T10:00:00Z'));
    // Seven calendar days back, landing on a GMT midnight.
    expect(window.startUtc.toISOString()).toBe('2026-03-26T00:00:00.000Z');
    expect(londonDaysInWindow(window)).toHaveLength(7);
    expect(londonDaysInWindow(window)[0]).toBe('2026-03-26');
    expect(londonDaysInWindow(window).at(-1)).toBe('2026-04-01');
  });

  it('spans whole London days across the autumn transition', () => {
    const window = resolveWindow('LAST_7', new Date('2026-10-27T10:00:00Z'));
    // Still BST seven days earlier, so the London day began at 23:00 UTC.
    expect(window.startUtc.toISOString()).toBe('2026-10-20T23:00:00.000Z');
    expect(londonDaysInWindow(window)).toHaveLength(7);
  });

  it('nests the windows, so Today is inside 7 days is inside 30 days', () => {
    const now = new Date('2026-04-01T10:00:00Z');
    const today = resolveWindow('TODAY', now);
    const week = resolveWindow('LAST_7', now);
    const month = resolveWindow('LAST_30', now);

    expect(week.startUtc.getTime()).toBeLessThan(today.startUtc.getTime());
    expect(month.startUtc.getTime()).toBeLessThan(week.startUtc.getTime());
    for (const window of [today, week, month]) {
      expect(window.endUtc.getTime()).toBe(now.getTime());
    }
  });

  it('never projects a window into the future', () => {
    const now = new Date('2026-07-15T10:00:00Z');
    for (const key of ['TODAY', 'LAST_7', 'LAST_30'] as WindowKey[]) {
      expect(resolveWindow(key, now).endUtc.getTime()).toBeLessThanOrEqual(now.getTime());
    }
  });

  it('falls back to Today for an unrecognised range parameter', () => {
    expect(parseWindowKey('LAST_7')).toBe('LAST_7');
    expect(parseWindowKey('LAST_90')).toBe('TODAY');
    expect(parseWindowKey(undefined)).toBe('TODAY');
    expect(parseWindowKey("'; drop table payments; --")).toBe('TODAY');
  });
});

/* ------------------------------------------------------------------ */
/* 10. Production-only traffic, and failing loudly                     */
/* ------------------------------------------------------------------ */

describe('Vercel traffic queries', () => {
  const credentials = { token: 'tok', projectId: 'prj_1', teamId: 'team_1' };
  const window = resolveWindow('LAST_7', new Date('2026-07-15T10:00:00Z'));

  it('always filters to the production environment', () => {
    expect(buildFilter()).toBe("environment eq 'production'");
    expect(buildFilter("route eq '/analyse'")).toBe(
      "environment eq 'production' and route eq '/analyse'",
    );
  });

  it('sends the window as the same instants the database will be asked for', () => {
    const params = buildQuery({ credentials, window });
    expect(params.get('since')).toBe(window.startUtc.toISOString());
    expect(params.get('until')).toBe(window.endUtc.toISOString());
    expect(params.get('projectId')).toBe('prj_1');
    expect(params.get('teamId')).toBe('team_1');
    expect(params.get('filter')).toContain("environment eq 'production'");
  });

  it('never puts the token in the query string', () => {
    const params = buildQuery({ credentials, window });
    expect(params.toString()).not.toContain('tok');
  });
});

describe('traffic reporting never invents a number', () => {
  const window = resolveWindow('TODAY', new Date('2026-07-15T10:00:00Z'));

  /**
   * Runs `run` with analytics credentials present.
   *
   * `serverEnv()` memoises, so the cache is cleared on the way in and on the
   * way out. Without the second reset the first test to run would populate the
   * cache with a token and every later test would keep seeing it — including
   * the one below that asserts what happens when there is none, which passed
   * for that reason before this was added.
   */
  async function withCredentials<T>(run: () => Promise<T>): Promise<T> {
    const previous = {
      token: process.env.VERCEL_ANALYTICS_TOKEN,
      project: process.env.VERCEL_PROJECT_ID,
      team: process.env.VERCEL_TEAM_ID,
    };
    process.env.VERCEL_ANALYTICS_TOKEN = 'tok';
    process.env.VERCEL_PROJECT_ID = 'prj_1';
    process.env.VERCEL_TEAM_ID = 'team_1';
    __resetServerEnvCache();
    try {
      return await run();
    } finally {
      process.env.VERCEL_ANALYTICS_TOKEN = previous.token;
      process.env.VERCEL_PROJECT_ID = previous.project;
      process.env.VERCEL_TEAM_ID = previous.team;
      __resetServerEnvCache();
    }
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('reports a rejected token as unavailable rather than as no traffic', async () => {
    const result = await withCredentials(() =>
      fetchTraffic(window, async () => json({ error: 'forbidden' }, 403)),
    );
    expect(result.kind).toBe('UNAVAILABLE');
    if (result.kind === 'UNAVAILABLE') expect(result.reason).toMatch(/token/i);
  });

  it('reports an unreachable API as unavailable rather than as no traffic', async () => {
    const result = await withCredentials(() =>
      fetchTraffic(window, async () => {
        throw new Error('ECONNRESET');
      }),
    );
    expect(result.kind).toBe('UNAVAILABLE');
  });

  it('refuses totals it cannot recognise instead of reading them as zero', async () => {
    const result = await withCredentials(() =>
      fetchTraffic(window, async () => json({ data: { hits: 12 } })),
    );
    expect(result.kind).toBe('UNAVAILABLE');
  });

  it('reads the documented totals shape', async () => {
    const result = await withCredentials(() =>
      fetchTraffic(window, async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/visits/count')) {
          return json({ version: 1, data: { pageviews: 1250, visitors: 980 } });
        }
        return json({ version: 1, data: [] });
      }),
    );

    expect(result.kind).toBe('OK');
    if (result.kind !== 'OK') return;
    expect(result.traffic.totals).toEqual({ pageViews: 1250, visitors: 980 });
  });

  it('asks for each funnel route by its route pattern, not by a literal path', async () => {
    const filters: string[] = [];
    await withCredentials(() =>
      fetchTraffic(window, async (input) => {
        const url = new URL(String(input));
        filters.push(url.searchParams.get('filter') ?? '');
        if (url.pathname.endsWith('/visits/count')) {
          return json({ data: { pageviews: 1, visitors: 1 } });
        }
        return json({ data: [] });
      }),
    );

    // `/case/<uuid>/defence` is a different path per customer, so only the route
    // pattern aggregates. Every filter still carries the production clause.
    expect(filters.some((f) => f.includes(`route eq '${DEFENCE_OFFER_ROUTE}'`))).toBe(true);
    expect(filters.some((f) => f.includes(`route eq '${ANALYSE_ROUTE}'`))).toBe(true);
    expect(filters.every((f) => f.includes("environment eq 'production'"))).toBe(true);
  });

  it('names a breakdown it could not read instead of showing an empty table', async () => {
    const result = await withCredentials(() =>
      fetchTraffic(window, async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/visits/count')) {
          return json({ data: { pageviews: 10, visitors: 8 } });
        }
        // Rows arrive, but under a dimension key we did not ask for.
        return json({ data: [{ somethingElse: '/x', pageviews: 4 }] });
      }),
    );

    expect(result.kind).toBe('OK');
    if (result.kind !== 'OK') return;
    expect(result.traffic.topPages).toEqual([]);
    expect(result.traffic.degraded).toContain('top pages');
  });

  it('reports itself unconfigured when no token is present', async () => {
    const previous = process.env.VERCEL_ANALYTICS_TOKEN;
    delete process.env.VERCEL_ANALYTICS_TOKEN;
    __resetServerEnvCache();
    try {
      const result = await fetchTraffic(window, async () => json({}));
      expect(result.kind).toBe('NOT_CONFIGURED');
      if (result.kind === 'NOT_CONFIGURED') {
        expect(result.missing).toContain('VERCEL_ANALYTICS_TOKEN');
      }
    } finally {
      if (previous !== undefined) process.env.VERCEL_ANALYTICS_TOKEN = previous;
      __resetServerEnvCache();
    }
  });
});
