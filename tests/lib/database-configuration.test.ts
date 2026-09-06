import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __resetServerEnvCache, isConfigured, serverEnv } from '@/lib/env';

/**
 * Resolving DATABASE_URL, through the same path `queryRows` uses.
 *
 * A live Vercel deployment reported "No Postgres connection configured" with a
 * correct DATABASE_URL set. The cause was not the database variable at all:
 * `serverEnv()` validates the whole environment in one parse, an unrelated
 * optional variable was present as an empty string, `z.string().min(1)`
 * rejected it, the entire object failed, and `getPool()` caught the throw and
 * returned null. One blank Anthropic key took the map down.
 *
 * These fix the contract that made that possible: an empty value means absent,
 * one broken optional integration cannot disable another, and readiness reports
 * what the pool would actually get.
 */

const OPTIONAL_KEYS = [
  'SUPABASE_SERVICE_ROLE_KEY',
  'ANTHROPIC_API_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'DTRO_CLIENT_ID',
  'DTRO_CLIENT_SECRET',
  'DTRO_BASE_URL',
  'CAMDEN_PCN_DATASET_URL',
  'CAMDEN_APP_TOKEN',
  'INGEST_TRIGGER_SECRET',
] as const;

const SAVED = new Map<string, string | undefined>();

function setEnv(values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (!SAVED.has(key)) SAVED.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  __resetServerEnvCache();
}

beforeEach(() => {
  // Start from a clean slate so a developer's own .env cannot decide the result.
  setEnv(Object.fromEntries([...OPTIONAL_KEYS, 'DATABASE_URL'].map((k) => [k, undefined])));
});

afterEach(() => {
  for (const [key, value] of SAVED) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  SAVED.clear();
  __resetServerEnvCache();
});

describe('resolving DATABASE_URL', () => {
  it('treats a transaction-pooler URL as configured', () => {
    setEnv({
      DATABASE_URL: 'postgresql://user:password@example.test:6543/postgres',
    });
    expect(serverEnv().DATABASE_URL).toBe('postgresql://user:password@example.test:6543/postgres');
    expect(isConfigured('database')).toBe(true);
  });

  it('accepts the postgres:// scheme as well as postgresql://', () => {
    setEnv({ DATABASE_URL: 'postgres://user:password@example.test:6543/postgres' });
    expect(serverEnv().DATABASE_URL).toBeTruthy();
    expect(isConfigured('database')).toBe(true);
  });

  it('reports unset as not configured', () => {
    setEnv({ DATABASE_URL: undefined });
    expect(serverEnv().DATABASE_URL).toBeUndefined();
    expect(isConfigured('database')).toBe(false);
  });

  it('reports empty as not configured, not as a validation failure', () => {
    setEnv({ DATABASE_URL: '' });
    expect(() => serverEnv()).not.toThrow();
    expect(serverEnv().DATABASE_URL).toBeUndefined();
    expect(isConfigured('database')).toBe(false);
  });

  it('treats whitespace as empty rather than as a connection string', () => {
    setEnv({ DATABASE_URL: '   ' });
    expect(serverEnv().DATABASE_URL).toBeUndefined();
    expect(isConfigured('database')).toBe(false);
  });
});

describe('an unrelated integration cannot disable the database', () => {
  const VALID = 'postgresql://user:password@example.test:6543/postgres';

  it.each(OPTIONAL_KEYS)('survives %s being present but empty', (key) => {
    // Exactly the deployed failure: the platform holds a blank value for an
    // integration that is not being launched yet.
    setEnv({ DATABASE_URL: VALID, [key]: '' });
    expect(() => serverEnv()).not.toThrow();
    expect(serverEnv().DATABASE_URL).toBe(VALID);
    expect(isConfigured('database')).toBe(true);
  });

  it('survives every optional integration being blank at once', () => {
    setEnv({
      DATABASE_URL: VALID,
      ...Object.fromEntries(OPTIONAL_KEYS.map((k) => [k, ''])),
    });
    expect(serverEnv().DATABASE_URL).toBe(VALID);
    expect(isConfigured('database')).toBe(true);
    expect(isConfigured('anthropic')).toBe(false);
    expect(isConfigured('stripe')).toBe(false);
  });

  it('survives a malformed optional URL, and disables only that integration', () => {
    setEnv({ DATABASE_URL: VALID, DTRO_BASE_URL: 'not-a-url', CAMDEN_PCN_DATASET_URL: 'nope' });
    expect(() => serverEnv()).not.toThrow();
    expect(isConfigured('database')).toBe(true);
    expect(isConfigured('dtro')).toBe(false);
    expect(isConfigured('camden')).toBe(false);
  });
});

describe('readiness agrees with what the pool would get', () => {
  it('does not report configured when the parser yields nothing', () => {
    // These disagreed before: readiness read process.env directly and said yes
    // while the pool read the parsed value and got nothing, so every page
    // believed it had a backend and then failed per query.
    setEnv({ DATABASE_URL: '  ' });
    expect(isConfigured('database')).toBe(false);
    expect(serverEnv().DATABASE_URL).toBeUndefined();
  });

  it('reports configured exactly when the parser yields a value', () => {
    setEnv({ DATABASE_URL: 'postgresql://user:password@example.test:6543/postgres' });
    expect(isConfigured('database')).toBe(Boolean(serverEnv().DATABASE_URL));
  });
});
