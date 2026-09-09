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

/**
 * Whether an event's `livemode` matches the mode this deployment is keyed for.
 *
 * The signature is the primary defence and this is the second one, because the
 * signature only proves the event came from whoever holds the secret — and the
 * way a Test event reaches a Live deployment is not an attack, it is
 * `STRIPE_WEBHOOK_SECRET` set to the Test endpoint's secret during the switch to
 * Live. One `whsec_` looks much like another, there is no feedback when the
 * wrong one is pasted, and the result is Production granting Defence Packs from
 * Test-mode payments with no money arriving and nothing complaining.
 *
 * Checkout already refuses a key/environment mismatch through `checkStripeMode`.
 * The webhook is the half that actually grants, and it had no equivalent.
 *
 * An UNKNOWN key mode refuses both, which is the correct answer for a
 * deployment whose configuration cannot be read.
 */
export function livemodeMatchesKey(eventLivemode: boolean, secretKey: string | undefined): boolean {
  const mode = stripeModeFromKey(secretKey);
  if (mode === 'LIVE') return eventLivemode === true;
  if (mode === 'TEST') return eventLivemode === false;
  return false;
}

/**
 * The same check against this deployment's configured key.
 *
 * Reads through `serverEnv()` rather than `process.env` for the same reason
 * `stripeReady()` does: that is the one validated view of the environment, and
 * a second way of reading the key is a second thing to keep in step.
 */
export function webhookModeAllowed(eventLivemode: boolean): boolean {
  return livemodeMatchesKey(eventLivemode, serverEnv().STRIPE_SECRET_KEY);
}
