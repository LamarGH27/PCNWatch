import { serverEnv } from '@/lib/env';

/**
 * Whether Stripe is in Test or Live mode, and whether that is allowed here.
 *
 * Stripe encodes the mode in the key itself — `sk_test_…` against `sk_live_…` —
 * which makes the mode a fact about the configuration rather than a setting
 * somebody has to remember to keep in step with it.
 *
 * Two mistakes are worth refusing outright, and they fail in opposite
 * directions. Live keys in a Preview deployment charge real cards during
 * testing. Test keys in Production take orders that were never paid for and
 * grant the product anyway — no money arrives, and nothing complains, because
 * from the application's point of view a Test-mode webhook is a successful
 * payment.
 *
 * `VERCEL_ENV` is the discriminator, for the same reason it is in
 * `previewAccessAvailable`: `NODE_ENV` is `production` for Preview builds too,
 * so it cannot tell the two apart.
 */

export type StripeMode = 'TEST' | 'LIVE' | 'UNKNOWN';

export type ModeVerdict =
  | { readonly allowed: true; readonly mode: StripeMode }
  | { readonly allowed: false; readonly mode: StripeMode; readonly reason: string };

export function stripeModeFromKey(secretKey: string | undefined): StripeMode {
  if (!secretKey) return 'UNKNOWN';
  if (secretKey.startsWith('sk_test_') || secretKey.startsWith('rk_test_')) return 'TEST';
  if (secretKey.startsWith('sk_live_') || secretKey.startsWith('rk_live_')) return 'LIVE';
  return 'UNKNOWN';
}

/** The deployment, as Vercel reports it. Absent off Vercel. */
export function deploymentEnvironment(): string {
  return process.env.VERCEL_ENV ?? 'development';
}

export function checkStripeMode(
  secretKey: string | undefined = process.env.STRIPE_SECRET_KEY,
  environment: string = deploymentEnvironment(),
): ModeVerdict {
  const mode = stripeModeFromKey(secretKey);

  if (mode === 'UNKNOWN') {
    return {
      allowed: false,
      mode,
      reason: 'The Stripe secret key is missing or is not a recognisable Stripe key.',
    };
  }

  if (environment === 'production' && mode === 'TEST') {
    return {
      allowed: false,
      mode,
      reason:
        'Production is configured with Stripe Test keys. A Test-mode payment would grant the product without any money arriving.',
    };
  }

  if (environment !== 'production' && mode === 'LIVE') {
    return {
      allowed: false,
      mode,
      reason:
        'A non-production deployment is configured with Stripe Live keys. Testing here would charge real cards.',
    };
  }

  return { allowed: true, mode };
}

/**
 * The mode checked against the environment, for a route about to take money.
 *
 * Throws nothing and grants nothing: callers get a verdict and decide. A
 * refusal here means checkout is unavailable, which is the correct outcome for
 * a deployment that is one environment variable away from charging the wrong
 * people.
 */
export function stripeReady(): ModeVerdict {
  const env = serverEnv();
  return checkStripeMode(env.STRIPE_SECRET_KEY);
}
