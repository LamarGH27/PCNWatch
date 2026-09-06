import { z } from 'zod';

/**
 * Environment contract for PCNWatch.
 *
 * Design rules:
 *  - Nothing here throws at module load in the browser. Only `NEXT_PUBLIC_*` values
 *    are readable client-side; server secrets live in a separate lazily-validated object.
 *  - Integrations that are not configured are *absent*, never faked. Call sites must
 *    check `isConfigured` and degrade to an explicit "not available" state.
 *  - `next build` must succeed without any credentials so CI can typecheck/build.
 */

/**
 * An optional setting that is absent, present, or wrong — and never fatal.
 *
 * Three things had to be true at once and only two were:
 *
 *  1. An unset variable and one set to the empty string mean the same thing.
 *    `.env.example` writes every unconfigured integration as `KEY=`, and a
 *    Vercel variable saved with a blank value arrives as `''`. Both mean "not
 *    configured", but `z.string().min(1)` rejected the second.
 *  2. `serverEnv()` parses the whole environment at once, so that rejection
 *    failed the *entire* object — and the read path resolves DATABASE_URL
 *    through it. A blank ANTHROPIC_API_KEY therefore disabled the database,
 *    which is how a live deployment with a correct DATABASE_URL reported
 *    "No Postgres connection configured".
 *  3. Beyond empty, a genuinely malformed optional value (a DTRO_BASE_URL that
 *    is not a URL) must disable its own integration and nothing else.
 *
 * So: empty becomes absent, and an invalid optional value falls back to absent
 * rather than taking the process down with it. Neither can fabricate a value —
 * the worst case is an integration correctly reporting itself unconfigured.
 */
const emptyAsUndefined = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const optionalUrl = z.preprocess(emptyAsUndefined, z.string().url().optional().catch(undefined));
const nonEmpty = z.preprocess(emptyAsUndefined, z.string().min(1).optional().catch(undefined));

/* ------------------------------------------------------------------ */
/* Public (client-safe) configuration                                  */
/* ------------------------------------------------------------------ */

/**
 * MapLibre's demo style, used when no basemap is configured.
 *
 * It contains country outlines from Natural Earth and nothing else, and its
 * sources stop at about zoom 5. At the zoom this product uses there is nothing
 * to draw but the background colour, so the map renders as a flat expanse with
 * the enforcement data floating on it — indistinguishable from a broken page.
 *
 * Kept as the default because a missing basemap must not stop the app starting,
 * but the map says plainly when it is in use rather than leaving someone to
 * wonder why there are no streets.
 */
export const PLACEHOLDER_MAP_STYLE_URL = 'https://demotiles.maplibre.org/style.json';

/** Whether the configured basemap is the placeholder rather than a real one. */
export function isPlaceholderMapStyle(styleUrl: string): boolean {
  return styleUrl.trim() === PLACEHOLDER_MAP_STYLE_URL;
}

// Next.js inlines `process.env.NEXT_PUBLIC_*` at build time only for literal
// property access, so these must be written out longhand.
const publicSchema = z.object({
  NEXT_PUBLIC_SITE_URL: z.string().url().default('http://localhost:3000'),
  NEXT_PUBLIC_SUPABASE_URL: optionalUrl,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: nonEmpty,
  NEXT_PUBLIC_MAP_STYLE_URL: z.string().min(1).default(PLACEHOLDER_MAP_STYLE_URL),
  NEXT_PUBLIC_MAP_ATTRIBUTION: z.string().min(1).default('© OpenStreetMap contributors'),
  NEXT_PUBLIC_POSTHOG_KEY: nonEmpty,
  NEXT_PUBLIC_POSTHOG_HOST: optionalUrl,
  NEXT_PUBLIC_FLAG_DTRO: z.enum(['on', 'off']).default('off'),
  NEXT_PUBLIC_FLAG_PAYMENTS: z.enum(['on', 'off']).default('off'),
});

const publicParsed = publicSchema.safeParse({
  NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  NEXT_PUBLIC_MAP_STYLE_URL: process.env.NEXT_PUBLIC_MAP_STYLE_URL,
  NEXT_PUBLIC_MAP_ATTRIBUTION: process.env.NEXT_PUBLIC_MAP_ATTRIBUTION,
  NEXT_PUBLIC_POSTHOG_KEY: process.env.NEXT_PUBLIC_POSTHOG_KEY,
  NEXT_PUBLIC_POSTHOG_HOST: process.env.NEXT_PUBLIC_POSTHOG_HOST,
  NEXT_PUBLIC_FLAG_DTRO: process.env.NEXT_PUBLIC_FLAG_DTRO,
  NEXT_PUBLIC_FLAG_PAYMENTS: process.env.NEXT_PUBLIC_FLAG_PAYMENTS,
});

if (!publicParsed.success) {
  // Public config has safe defaults for everything optional, so a failure here is a
  // genuine misconfiguration (e.g. a malformed URL) and should be loud.
  throw new Error(
    `Invalid public environment configuration:\n${JSON.stringify(
      z.treeifyError(publicParsed.error),
      null,
      2,
    )}`,
  );
}

export const publicEnv = publicParsed.data;

/* ------------------------------------------------------------------ */
/* Server-only configuration                                           */
/* ------------------------------------------------------------------ */

const serverSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  SUPABASE_SERVICE_ROLE_KEY: nonEmpty,
  // Not `nonEmpty`: this one may not quietly fall back to absent. Everything
  // public the product shows is read through it, so a malformed value must say
  // so rather than present itself as an unconfigured integration.
  DATABASE_URL: z.preprocess(emptyAsUndefined, z.string().min(1).optional()),

  ANTHROPIC_API_KEY: nonEmpty,
  ANTHROPIC_MODEL: z.string().min(1).default('claude-sonnet-5'),

  STRIPE_SECRET_KEY: nonEmpty,
  STRIPE_WEBHOOK_SECRET: nonEmpty,

  DTRO_CLIENT_ID: nonEmpty,
  DTRO_CLIENT_SECRET: nonEmpty,
  DTRO_BASE_URL: optionalUrl,

  CAMDEN_PCN_DATASET_URL: optionalUrl,
  CAMDEN_APP_TOKEN: nonEmpty,

  ADMIN_EMAIL_ALLOWLIST: z.string().default(''),
  INGEST_TRIGGER_SECRET: nonEmpty,
});

export type ServerEnv = z.infer<typeof serverSchema>;

let cachedServerEnv: ServerEnv | null = null;

/**
 * Lazily read + validate server environment. Throws only when actually called,
 * which keeps client bundles and `next build` free of credential requirements.
 */
export function serverEnv(): ServerEnv {
  if (typeof window !== 'undefined') {
    throw new Error('serverEnv() must never be called from client code.');
  }
  if (cachedServerEnv) return cachedServerEnv;
  const parsed = serverSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(
      `Invalid server environment configuration:\n${JSON.stringify(z.treeifyError(parsed.error), null, 2)}`,
    );
  }
  cachedServerEnv = parsed.data;
  return cachedServerEnv;
}

/** Test-only hook so suites can reset memoised config. */
export function __resetServerEnvCache(): void {
  cachedServerEnv = null;
}

/* ------------------------------------------------------------------ */
/* Integration readiness                                               */
/* ------------------------------------------------------------------ */

export type IntegrationName =
  | 'supabase'
  | 'database'
  | 'anthropic'
  | 'stripe'
  | 'dtro'
  | 'camden'
  | 'posthog';

export interface IntegrationStatus {
  name: IntegrationName;
  configured: boolean;
  /** Env vars that must be present for this integration to be usable. */
  requires: readonly string[];
  missing: readonly string[];
}

function statusFor(name: IntegrationName, requires: readonly string[]): IntegrationStatus {
  // Read through the parsed environment, not raw `process.env`.
  //
  // These two disagreed, and the disagreement is what hid the failure above:
  // `isConfigured('database')` read `process.env.DATABASE_URL` and said yes,
  // while the pool resolved the same value through `serverEnv()` and got
  // nothing. Every page therefore believed it had a backend and then failed
  // per-query. Whatever the pool uses is what readiness must report.
  let server: Record<string, unknown> = {};
  try {
    server = serverEnv() as unknown as Record<string, unknown>;
  } catch {
    // Server config is unreadable, so nothing server-side is configured. The
    // reason is logged by whoever needed it; this only reports the state.
    server = {};
  }

  const missing = requires.filter((key) => {
    const value = key.startsWith('NEXT_PUBLIC_')
      ? (publicEnv as Record<string, unknown>)[key]
      : server[key];
    return value === undefined || value === null || value === '';
  });
  return { name, configured: missing.length === 0, requires, missing };
}

/**
 * Server-side readiness snapshot. Used by the admin data-health page and by
 * adapters that must refuse to run rather than invent a successful response.
 */
export function integrationStatuses(): IntegrationStatus[] {
  return [
    statusFor('supabase', [
      'NEXT_PUBLIC_SUPABASE_URL',
      'NEXT_PUBLIC_SUPABASE_ANON_KEY',
      'SUPABASE_SERVICE_ROLE_KEY',
    ]),
    // Reported separately from Supabase because it is separately required. The
    // Supabase client can call database functions, but it cannot run the plain
    // SQL behind the coverage banner, the contravention filter and the authority
    // contravention labels — those go through `queryRows`, which is Postgres
    // only. A deployment with Supabase configured and no DATABASE_URL builds,
    // starts, and then reports "data temporarily unavailable" on every page.
    statusFor('database', ['DATABASE_URL']),
    statusFor('anthropic', ['ANTHROPIC_API_KEY']),
    statusFor('stripe', ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']),
    statusFor('dtro', ['DTRO_CLIENT_ID', 'DTRO_CLIENT_SECRET', 'DTRO_BASE_URL']),
    statusFor('camden', ['CAMDEN_PCN_DATASET_URL']),
    statusFor('posthog', ['NEXT_PUBLIC_POSTHOG_KEY']),
  ];
}

export function isConfigured(name: IntegrationName): boolean {
  return integrationStatuses().find((s) => s.name === name)?.configured ?? false;
}

/** Client-safe: Supabase browser client can only be built when both public keys exist. */
export const supabasePublicConfigured =
  Boolean(publicEnv.NEXT_PUBLIC_SUPABASE_URL) && Boolean(publicEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY);

export const featureFlags = {
  dtro: publicEnv.NEXT_PUBLIC_FLAG_DTRO === 'on',
  payments: publicEnv.NEXT_PUBLIC_FLAG_PAYMENTS === 'on',
} as const;
