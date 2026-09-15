import { createSupabaseServiceClient } from '@/lib/supabase/server';
import { serverEnv } from '@/lib/env';
import { logError } from '@/lib/errors';
import type { DateWindow } from './window';

/**
 * The commercial funnel, from the tables that already record it.
 *
 * Nothing here invents a metric. Every number is a count or a sum of rows the
 * product already writes in the ordinary course of taking a payment, and the
 * point of the module is to be precise about which rows.
 *
 * Two separations matter and neither is cosmetic.
 *
 * **Money is not contaminable.** A `PAID` row carries `livemode` read off the
 * Stripe event itself, and `checkStripeMode` refuses Live keys anywhere but
 * Production — so `livemode = true` is proof the row came from Production, no
 * matter which Supabase project Preview happens to point at.
 *
 * **Case volume is.** Nothing on a `pcn_cases` or `pcn_drafts` row says which
 * deployment wrote it. If Preview shares this Supabase project then operator
 * testing is inside those counts and no query can take it out again. So they
 * are gated on `ANALYTICS_DB_SCOPE`, and an unset value means unknown, which
 * reports as unavailable rather than as a number.
 *
 * Nothing in this module selects a PCN number, a registration, a narrative, a
 * name, a case id, a user id or a Stripe identifier into its result. The
 * returned shape holds counts, sums and fixed labels, so there is nothing for
 * the page to leak even by accident.
 */

/* ------------------------------------------------------------------ */
/* Result shapes                                                       */
/* ------------------------------------------------------------------ */

/**
 * A number, or a stated reason there isn't one.
 *
 * A dashboard that renders an unknown as `0` is worse than one that renders
 * nothing: zero purchases is a fact worth acting on, and "we cannot tell" is a
 * different fact entirely. They never share a representation here.
 */
export type Metric =
  | { readonly kind: 'VALUE'; readonly value: number }
  | { readonly kind: 'UNAVAILABLE'; readonly reason: string };

export const value = (n: number): Metric => ({ kind: 'VALUE', value: n });
export const unavailable = (reason: string): Metric => ({ kind: 'UNAVAILABLE', reason });

export type DbScope = 'PRODUCTION_ONLY' | 'SHARED_WITH_PREVIEW' | 'UNKNOWN';

export interface FunnelCounts {
  /** Cases that reached the point of requesting an assessment. */
  readonly casesReachingAssessment: Metric;
  /** Cases where an assessment then completed successfully. */
  readonly assessmentsCompleted: Metric;
  /** Checkout Sessions opened, attributed to Production. */
  readonly checkouts: Metric;
  /** Checkout rows that could not be attributed to either Stripe mode. */
  readonly checkoutsUnattributed: number;
  /** Webhook-confirmed Live payments in GBP. */
  readonly purchases: Metric;
  /** Sum of `amount_pence` over exactly those payments. Gross, never net. */
  readonly grossCollectedPence: Metric;
  /** Current Defence Packs generated. */
  readonly defencePacks: Metric;
  readonly scope: DbScope;
  readonly datastoreAvailable: boolean;
}

/* ------------------------------------------------------------------ */
/* Row shapes — deliberately the narrowest columns that answer the job  */
/* ------------------------------------------------------------------ */

export interface PaymentRow {
  readonly status: string | null;
  readonly confirmed_by_webhook_at: string | null;
  readonly livemode: boolean | null;
  readonly currency: string | null;
  readonly amount_pence: number | null;
  readonly stripe_price_id: string | null;
}

/* ------------------------------------------------------------------ */
/* Pure classification                                                 */
/* ------------------------------------------------------------------ */

/**
 * Whether a payment row counts as real money PCNWatch collected.
 *
 * All four clauses are load-bearing:
 *
 *   * `PAID` — the terminal state, not an attempt;
 *   * `confirmed_by_webhook_at` — set only by the webhook. The database already
 *     refuses `PAID` without it, and this refuses to trust that it did;
 *   * `livemode` — a Test-mode payment looks identical downstream and took no
 *     money;
 *   * `GBP` — the catalogue prices in sterling and the sum is shown in
 *     sterling, so a row in anything else is not addable and is not guessed at.
 */
export function isCollectedPayment(row: PaymentRow): boolean {
  return (
    row.status === 'PAID' &&
    row.confirmed_by_webhook_at !== null &&
    row.confirmed_by_webhook_at !== undefined &&
    row.livemode === true &&
    String(row.currency ?? '').toUpperCase() === 'GBP'
  );
}

export type CheckoutAttribution = 'PRODUCTION' | 'NON_PRODUCTION' | 'UNATTRIBUTED';

/**
 * Which deployment opened a Checkout Session.
 *
 * `livemode` is written by the webhook, so a row that was never paid has none
 * and the mode has to come from somewhere else. The Price does it: Live and
 * Test Prices are different objects in Stripe, a Live Price can only be used by
 * a deployment holding Live keys, and only Production may hold those. So a row
 * carrying the configured Live Price was opened by Production.
 *
 * A row with neither signal — a session that failed before Stripe answered, so
 * no Price was ever recorded — is reported as unattributed rather than assigned
 * to whichever side would flatter the conversion rate.
 */
export function attributeCheckout(row: PaymentRow, livePriceId: string | undefined): CheckoutAttribution {
  if (row.livemode === true) return 'PRODUCTION';
  if (row.livemode === false) return 'NON_PRODUCTION';
  if (!livePriceId || !row.stripe_price_id) return 'UNATTRIBUTED';
  return row.stripe_price_id === livePriceId ? 'PRODUCTION' : 'NON_PRODUCTION';
}

export interface PaymentSummary {
  readonly purchases: number;
  readonly grossCollectedPence: number;
  readonly checkouts: number;
  readonly checkoutsUnattributed: number;
}

/** Applies the two classifications above across a window's rows. */
export function summarisePayments(
  checkoutRows: readonly PaymentRow[],
  paidRows: readonly PaymentRow[],
  livePriceId: string | undefined,
): PaymentSummary {
  let checkouts = 0;
  let checkoutsUnattributed = 0;
  for (const row of checkoutRows) {
    const attribution = attributeCheckout(row, livePriceId);
    if (attribution === 'PRODUCTION') checkouts += 1;
    else if (attribution === 'UNATTRIBUTED') checkoutsUnattributed += 1;
  }

  const collected = paidRows.filter(isCollectedPayment);

  return {
    purchases: collected.length,
    grossCollectedPence: collected.reduce((total, row) => total + Number(row.amount_pence ?? 0), 0),
    checkouts,
    checkoutsUnattributed,
  };
}

/** How the deployment has been told to read its own Supabase project. */
export function resolveScope(raw: string | undefined): DbScope {
  if (raw === 'PRODUCTION_ONLY') return 'PRODUCTION_ONLY';
  if (raw === 'SHARED_WITH_PREVIEW') return 'SHARED_WITH_PREVIEW';
  return 'UNKNOWN';
}

export const SCOPE_UNKNOWN_REASON =
  'ANALYTICS_DB_SCOPE is not set, so Preview activity cannot be ruled out of this count.';
export const SCOPE_SHARED_REASON =
  'Preview shares this Supabase project, and no column records which deployment wrote a row.';

/**
 * Wraps a count that only means "Production" if the database is Production-only.
 *
 * Fails closed: anything other than an explicit `PRODUCTION_ONLY` refuses to
 * present the number.
 */
export function scopedCount(count: number, scope: DbScope): Metric {
  if (scope === 'PRODUCTION_ONLY') return value(count);
  return unavailable(scope === 'SHARED_WITH_PREVIEW' ? SCOPE_SHARED_REASON : SCOPE_UNKNOWN_REASON);
}

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */

/** A payment row set larger than this is truncated; the page says so. */
const PAYMENT_ROW_CAP = 5000;

const PAYMENT_COLUMNS = 'status, confirmed_by_webhook_at, livemode, currency, amount_pence, stripe_price_id';

export async function getFunnel(window: DateWindow): Promise<FunnelCounts> {
  let scope: DbScope = 'UNKNOWN';
  let livePriceId: string | undefined;
  try {
    const env = serverEnv();
    scope = resolveScope(env.ANALYTICS_DB_SCOPE);
    livePriceId = env.STRIPE_DEFENCE_PACK_PRICE_ID;
  } catch (error) {
    logError('admin.analytics.env', error);
  }

  let supabase: ReturnType<typeof createSupabaseServiceClient> = null;
  try {
    supabase = createSupabaseServiceClient();
  } catch (error) {
    logError('admin.analytics.client', error);
  }

  const offline = (reason: string): FunnelCounts => ({
    casesReachingAssessment: unavailable(reason),
    assessmentsCompleted: unavailable(reason),
    checkouts: unavailable(reason),
    checkoutsUnattributed: 0,
    purchases: unavailable(reason),
    grossCollectedPence: unavailable(reason),
    defencePacks: unavailable(reason),
    scope,
    datastoreAvailable: false,
  });

  if (!supabase) return offline('Supabase is not configured on this deployment.');

  const since = window.startUtc.toISOString();
  const until = window.endUtc.toISOString();

  try {
    const [cases, assessed, packs, checkoutRows, paidRows] = await Promise.all([
      supabase
        .from('pcn_cases')
        .select('id', { count: 'exact', head: true })
        .gte('created_at', since)
        .lt('created_at', until),
      supabase
        .from('pcn_cases')
        .select('id', { count: 'exact', head: true })
        .gte('last_assessed_at', since)
        .lt('last_assessed_at', until),
      supabase
        .from('pcn_drafts')
        .select('id', { count: 'exact', head: true })
        .gte('generated_at', since)
        .lt('generated_at', until),
      // Windowed on when the attempt was opened.
      supabase
        .from('payments')
        .select(PAYMENT_COLUMNS)
        .gte('created_at', since)
        .lt('created_at', until)
        .limit(PAYMENT_ROW_CAP),
      // Windowed on when the money was confirmed, which is the date the revenue
      // belongs to — a session opened on Monday and paid on Tuesday is Tuesday's.
      supabase
        .from('payments')
        .select(PAYMENT_COLUMNS)
        .gte('confirmed_by_webhook_at', since)
        .lt('confirmed_by_webhook_at', until)
        .limit(PAYMENT_ROW_CAP),
    ]);

    for (const result of [cases, assessed, packs, checkoutRows, paidRows]) {
      if (result.error) throw result.error;
    }

    const payments = summarisePayments(
      (checkoutRows.data ?? []) as unknown as PaymentRow[],
      (paidRows.data ?? []) as unknown as PaymentRow[],
      livePriceId,
    );

    return {
      casesReachingAssessment: scopedCount(cases.count ?? 0, scope),
      assessmentsCompleted: scopedCount(assessed.count ?? 0, scope),
      defencePacks: scopedCount(packs.count ?? 0, scope),
      checkouts: value(payments.checkouts),
      checkoutsUnattributed: payments.checkoutsUnattributed,
      purchases: value(payments.purchases),
      grossCollectedPence: value(payments.grossCollectedPence),
      scope,
      datastoreAvailable: true,
    };
  } catch (error) {
    logError('admin.analytics.getFunnel', error);
    return offline('The analytics query failed. See the server log for the correlation id.');
  }
}
