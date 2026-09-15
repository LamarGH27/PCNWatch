import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What the analytics query is allowed to touch, and what it is allowed to
 * return.
 *
 * The dashboard is the one operator surface that reads customer tables in bulk,
 * so the interesting question is not whether the page happens to render a PCN
 * number today — it is whether one could ever reach the page at all. Both ends
 * are pinned here: the columns the queries ask for, and the object they hand
 * back.
 */

interface Recorded {
  readonly table: string;
  readonly columns: string;
}

const state = {
  selects: [] as Recorded[],
  rowsByTable: {} as Record<string, Record<string, unknown>[]>,
  countsByTable: {} as Record<string, number>,
};

/**
 * A Supabase stand-in that records every `select` and replays whatever rows the
 * test put in for that table.
 *
 * The builder is thenable because `getFunnel` awaits the query objects
 * directly, exactly as the real client allows.
 */
vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServiceClient: () => ({
    from(table: string) {
      const builder = {
        select(columns: string, options?: { count?: string; head?: boolean }) {
          state.selects.push({ table, columns });
          const result = options?.head
            ? { data: null, count: state.countsByTable[table] ?? 0, error: null }
            : { data: state.rowsByTable[table] ?? [], count: null, error: null };
          const chain = {
            gte: () => chain,
            lt: () => chain,
            limit: () => chain,
            then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
          };
          return chain;
        },
      };
      return builder;
    },
  }),
}));

const { getFunnel } = await import('@/server/admin/analytics');
const { resolveWindow } = await import('@/server/admin/window');

/** Values that must never appear in an analytics result, in any form. */
const SENSITIVE = {
  pcn_number: 'CA12345678',
  vrm: 'AB12CDE',
  user_narrative: 'I was only parked for two minutes outside the school',
  location_text: '14 Example Street, London NW1 2ZZ',
  correspondence_name: 'A Real Person',
  correspondence_address: '14 Example Street, London NW1 2ZZ',
  user_id: '11111111-1111-4111-8111-111111111111',
  case_id: '22222222-2222-4222-8222-222222222222',
  stripe_checkout_session_id: 'cs_live_a1b2c3d4e5',
  stripe_payment_intent_id: 'pi_live_a1b2c3d4e5',
  stripe_charge_id: 'ch_live_a1b2c3d4e5',
  stripe_price_id: 'price_live_defence_pack',
};

const WINDOW = resolveWindow('LAST_7', new Date('2026-07-15T10:00:00Z'));

beforeEach(() => {
  state.selects = [];
  state.rowsByTable = {};
  state.countsByTable = {};
  process.env.ANALYTICS_DB_SCOPE = 'PRODUCTION_ONLY';
  process.env.STRIPE_DEFENCE_PACK_PRICE_ID = SENSITIVE.stripe_price_id;
});

afterEach(() => {
  delete process.env.ANALYTICS_DB_SCOPE;
  vi.resetModules();
});

describe('the analytics query asks for nothing sensitive', () => {
  it('selects only counting columns from the case tables', async () => {
    await getFunnel(WINDOW);

    const caseSelects = state.selects.filter(
      (select) => select.table === 'pcn_cases' || select.table === 'pcn_drafts',
    );
    expect(caseSelects.length).toBeGreaterThan(0);
    for (const select of caseSelects) {
      // An id for the counter to count, and nothing else. Never a PCN number, a
      // registration, a narrative, a location or a document.
      expect(select.columns).toBe('id');
    }
  });

  it('selects no customer or Stripe identifier from payments', async () => {
    await getFunnel(WINDOW);

    const paymentSelects = state.selects.filter((select) => select.table === 'payments');
    expect(paymentSelects.length).toBeGreaterThan(0);
    for (const select of paymentSelects) {
      for (const forbidden of [
        'user_id',
        'case_id',
        'stripe_checkout_session_id',
        'stripe_payment_intent_id',
        'stripe_charge_id',
      ]) {
        expect(select.columns).not.toContain(forbidden);
      }
    }
  });
});

describe('the analytics result carries nothing sensitive', () => {
  it('returns only counts and sums even when every row is full of customer data', async () => {
    /*
     * The rows are deliberately far wider than the queries ask for. A stand-in
     * cannot enforce column projection, so this proves the second line of
     * defence: even handed everything, the module builds its result out of
     * counts and never passes a row through.
     */
    state.countsByTable['pcn_cases'] = 12;
    state.countsByTable['pcn_drafts'] = 4;
    state.rowsByTable['payments'] = [
      {
        status: 'PAID',
        confirmed_by_webhook_at: '2026-07-14T10:00:00.000Z',
        livemode: true,
        currency: 'GBP',
        amount_pence: 599,
        ...SENSITIVE,
      },
    ];

    const funnel = await getFunnel(WINDOW);
    const serialised = JSON.stringify(funnel);

    for (const [field, secret] of Object.entries(SENSITIVE)) {
      expect(serialised, `${field} reached the analytics result`).not.toContain(secret);
    }

    // And the numbers it did produce are the right ones, so the assertion above
    // is not passing merely because the result is empty.
    expect(funnel.purchases).toEqual({ kind: 'VALUE', value: 1 });
    expect(funnel.grossCollectedPence).toEqual({ kind: 'VALUE', value: 599 });
    expect(funnel.casesReachingAssessment).toEqual({ kind: 'VALUE', value: 12 });
    expect(funnel.defencePacks).toEqual({ kind: 'VALUE', value: 4 });
  });

  it('holds no free-text field at all', async () => {
    state.countsByTable['pcn_cases'] = 3;
    state.rowsByTable['payments'] = [];

    const funnel = await getFunnel(WINDOW);

    // Every leaf is a number, a boolean, or one of the module's own fixed
    // labels. Nothing that came from a row.
    const leaves: unknown[] = [];
    const walk = (node: unknown) => {
      if (Array.isArray(node)) node.forEach(walk);
      else if (node && typeof node === 'object') Object.values(node).forEach(walk);
      else leaves.push(node);
    };
    walk(funnel);

    const allowedStrings = new Set(['VALUE', 'UNAVAILABLE', 'PRODUCTION_ONLY']);
    for (const leaf of leaves) {
      if (typeof leaf === 'string') expect(allowedStrings.has(leaf)).toBe(true);
      else expect(['number', 'boolean']).toContain(typeof leaf);
    }
  });
});
