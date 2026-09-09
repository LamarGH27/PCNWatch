import { publicEnv } from '@/lib/env';

/**
 * Where Stripe sends the user back to.
 *
 * This is a security boundary, and it failed in the ordinary direction: a
 * Checkout Session created on a Preview deployment carried the Production
 * domain, so a completed Sandbox payment would have returned the user to a
 * different environment entirely — one where their session cookie does not
 * exist and the case they just paid for cannot be found.
 *
 * The cause was reusing `NEXT_PUBLIC_SITE_URL`. That variable is correct for
 * what it was built for: `robots.txt`, `sitemap.xml` and `metadataBase` all
 * want the canonical public domain *even on Preview*, or search engines index
 * preview hosts. It is the wrong answer for "which deployment is this request
 * running on", and the two questions had been collapsed into one variable.
 *
 * The rule here is that a return origin is either explicitly configured or
 * derived from Vercel's own server-side variables. It is never taken from the
 * request. `Host`, `X-Forwarded-Host`, `Origin` and `Referer` are all
 * attacker-controlled on any request that reaches the app, and a Checkout
 * Session built from one would let somebody hand a victim a link that pays on
 * this deployment and returns to a domain they own. Nothing in this file reads
 * a header, and a test proves the route does not either.
 *
 * Failing closed matters more than being clever: an origin we cannot establish
 * refuses checkout rather than guessing, because the guess is what sends a
 * paying customer somewhere else.
 */

export type OriginSource =
  /** `CHECKOUT_RETURN_ORIGIN` was set. An operator's explicit instruction. */
  | 'CONFIGURED'
  /** Vercel's own `VERCEL_URL` for this deployment. */
  | 'VERCEL_DEPLOYMENT'
  /** The canonical public site. Production, and local development. */
  | 'SITE_URL';

export type OriginVerdict =
  | { readonly ok: true; readonly origin: string; readonly source: OriginSource }
  | { readonly ok: false; readonly reason: string };

export interface OriginEnv {
  /** `VERCEL_ENV`. Absent off Vercel. */
  readonly vercelEnv: string | undefined;
  /** `VERCEL_URL`. Host only, no scheme — Vercel does not include one. */
  readonly vercelUrl: string | undefined;
  /** `NEXT_PUBLIC_SITE_URL`. The canonical public domain. */
  readonly siteUrl: string;
  /** `CHECKOUT_RETURN_ORIGIN`. Optional operator override. */
  readonly configured: string | undefined;
}

/**
 * Whether a candidate is a bare, safe origin.
 *
 * `URL.origin` would quietly discard a path, a query and a fragment, which is
 * the sort of helpfulness that turns a misconfiguration into a redirect nobody
 * notices. So anything beyond a bare origin is refused rather than trimmed —
 * with the single exception of a trailing slash, which is how people write a
 * site URL and means nothing.
 */
function acceptOrigin(candidate: string, source: OriginSource): OriginVerdict {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { ok: false, reason: `The ${source} origin is not a valid URL.` };
  }

  const localhost = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && localhost)) {
    // http is for `next dev` and nothing else. Stripe will not redirect a real
    // customer over a scheme that can be rewritten in transit.
    return { ok: false, reason: `The ${source} origin must use https.` };
  }
  if (url.username || url.password) {
    return { ok: false, reason: `The ${source} origin must not carry credentials.` };
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    return { ok: false, reason: `The ${source} origin must not carry a path.` };
  }
  if (url.search || url.hash) {
    return { ok: false, reason: `The ${source} origin must not carry a query or fragment.` };
  }

  return { ok: true, origin: url.origin, source };
}

/**
 * Resolves the return origin from environment alone.
 *
 * Pure, and takes its environment as an argument, so every branch can be tested
 * without a deployment. `checkoutOrigin()` below is the thin wrapper that reads
 * the real one.
 */
export function resolveCheckoutOrigin(env: OriginEnv): OriginVerdict {
  /*
   * An explicit setting wins everywhere.
   *
   * The escape hatch for the case the Vercel default gets wrong: testing
   * through a branch alias rather than the deployment URL. Returning to a
   * different host than the browser is on would leave the session cookie
   * behind and the user apparently signed out, so an operator who tests
   * through an alias needs a way to say so.
   */
  if (env.configured) return acceptOrigin(env.configured, 'CONFIGURED');

  /*
   * Production returns to the canonical domain, not to `VERCEL_URL`.
   *
   * A production deployment also has a `*.vercel.app` deployment URL, and
   * sending a paying customer back to it would work while looking wrong and
   * would break the moment a custom domain is added.
   */
  if (env.vercelEnv === 'production') return acceptOrigin(env.siteUrl, 'SITE_URL');

  /*
   * Preview returns to the deployment that served the request.
   *
   * `VERCEL_URL` is set by the platform per deployment and is not reachable
   * from a request, so it cannot be influenced by a caller — which is the
   * property that makes it usable here at all.
   */
  if (env.vercelEnv === 'preview') {
    if (!env.vercelUrl) {
      return { ok: false, reason: 'This is a Preview deployment but VERCEL_URL is not set.' };
    }
    return acceptOrigin(`https://${env.vercelUrl}`, 'VERCEL_DEPLOYMENT');
  }

  // Off Vercel: `next dev`, the test suite, a self-hosted run.
  if (env.vercelEnv === undefined || env.vercelEnv === 'development') {
    return acceptOrigin(env.siteUrl, 'SITE_URL');
  }

  /*
   * A `VERCEL_ENV` value Vercel has not invented yet.
   *
   * Refused rather than defaulted, for the same reason `previewAccessAvailable`
   * asks for exactly "preview": a fallback here would silently apply Production
   * behaviour to an environment nobody has thought about.
   */
  return { ok: false, reason: `Unrecognised deployment environment "${env.vercelEnv}".` };
}

/** The resolved origin for this deployment. Reads no part of any request. */
export function checkoutOrigin(): OriginVerdict {
  return resolveCheckoutOrigin({
    vercelEnv: process.env.VERCEL_ENV,
    vercelUrl: process.env.VERCEL_URL,
    siteUrl: publicEnv.NEXT_PUBLIC_SITE_URL,
    configured: process.env.CHECKOUT_RETURN_ORIGIN,
  });
}

/** Where Stripe returns the user for one case. The only builder of these. */
export function checkoutReturnUrls(origin: string, caseId: string) {
  // The id is already validated as a uuid before it reaches here; encoding it
  // is belt and braces so no future caller can put a path separator in the URL.
  const base = `${origin}/case/${encodeURIComponent(caseId)}/defence`;
  return {
    successUrl: `${base}?checkout=returned`,
    cancelUrl: `${base}?checkout=cancelled`,
  } as const;
}
