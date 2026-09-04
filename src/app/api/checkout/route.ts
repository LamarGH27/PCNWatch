import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { publicEnv, featureFlags } from '@/lib/env';
import { AppError, logError } from '@/lib/errors';
import { getProduct } from '@/server/payments/catalogue';
import { createCheckoutSession } from '@/server/payments/stripe';
import { rateLimit } from '@/server/rate-limit';

/**
 * Starts a Stripe Checkout session.
 *
 * What this route does NOT do is as important as what it does: it grants nothing.
 * The session's success URL returns the user to their case, and entitlement comes
 * only from the webhook. A user who completes payment and closes the tab before
 * the redirect still gets what they paid for; a user who visits the success URL
 * without paying gets nothing.
 */

export async function POST(request: Request) {
  if (!featureFlags.payments) {
    return NextResponse.json(
      { error: 'Payments are not enabled on this deployment.' },
      { status: 503 },
    );
  }

  const url = new URL(request.url);
  const caseId = url.searchParams.get('case');
  const sku = url.searchParams.get('sku');

  if (!caseId || !/^[0-9a-f-]{36}$/i.test(caseId) || !sku) {
    return NextResponse.json({ error: 'Invalid checkout request.' }, { status: 400 });
  }

  const product = getProduct(sku);
  if (!product) {
    return NextResponse.json({ error: 'Unknown product.' }, { status: 400 });
  }

  const limited = await rateLimit(request, { key: 'checkout', limit: 10, windowSeconds: 600 });
  if (!limited.allowed) {
    return NextResponse.json({ error: 'Too many attempts.' }, { status: 429 });
  }

  try {
    const supabase = await createSupabaseServerClient();
    if (!supabase) throw new Error('SUPABASE_NOT_CONFIGURED');

    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.redirect(new URL(`/sign-in?next=/case/${caseId}/draft`, url.origin), 303);
    }

    // Confirm the case is the user's own before creating a session against it.
    // RLS returns no row otherwise, so this is a check on visibility, not a
    // second authorisation system.
    const { data: ownedCase } = await supabase
      .from('pcn_cases')
      .select('id')
      .eq('id', caseId)
      .maybeSingle();
    if (!ownedCase) {
      return NextResponse.json({ error: 'Case not found.' }, { status: 404 });
    }

    const base = publicEnv.NEXT_PUBLIC_SITE_URL.replace(/\/$/, '');
    const session = await createCheckoutSession({
      product,
      userId: user.id,
      caseId,
      customerEmail: user.email ?? undefined,
      // The success URL identifies where to look. It proves nothing.
      successUrl: `${base}/case/${caseId}/draft?checkout=returned`,
      cancelUrl: `${base}/case/${caseId}/draft?checkout=cancelled`,
    });

    return NextResponse.redirect(session.url, 303);
  } catch (error) {
    const correlationId = logError('api.checkout', error, { sku });
    if (error instanceof AppError) {
      return NextResponse.json(
        { error: error.what, whatYouCanDo: error.whatYouCanDo, correlationId },
        { status: 503 },
      );
    }
    return NextResponse.json(
      {
        error: 'We could not start the payment.',
        whatYouCanDo: 'Nothing has been charged. Please try again in a moment.',
        correlationId,
      },
      { status: 500 },
    );
  }
}
