import { Pool } from 'pg';
import { isConfigured, serverEnv } from '@/lib/env';
import { createSupabaseServiceClient } from '@/lib/supabase/server';
import { logError } from '@/lib/errors';

/**
 * Read access to public enforcement data, over whichever transport is configured.
 *
 * Two backends, one contract:
 *   - Supabase, when the project is configured (the hosted path).
 *   - A direct PostgreSQL connection via DATABASE_URL otherwise.
 *
 * The second exists because the map is the product's core claim, and requiring a
 * hosted Supabase project before anyone can look at ingested data would mean the
 * pipeline could be proven only in the abstract. Both paths call the same
 * database functions with the same arguments, so neither can drift into showing
 * something the other would not.
 *
 * Neither backend configured is a *failure*, never an empty result: the caller
 * must be able to tell "we could not look" apart from "we looked and found none".
 */

export type DbResult<T> =
  | { readonly ok: true; readonly rows: T[]; readonly backend: 'supabase' | 'postgres' }
  | { readonly ok: false; readonly correlationId: string; readonly reason: string };

let pool: Pool | null = null;

function getPool(): Pool | null {
  if (pool) return pool;
  let connectionString: string | undefined;
  try {
    connectionString = serverEnv().DATABASE_URL;
  } catch {
    return null;
  }
  if (!connectionString) return null;

  pool = new Pool({
    connectionString,
    // Read path: small pool, short timeout. A slow map query must fail fast and
    // render "temporarily unavailable" rather than hold a request open.
    max: 5,
    statement_timeout: 10_000,
    idleTimeoutMillis: 30_000,
    ssl: /^postgres(ql)?:\/\/[^/]*(localhost|127\.0\.0\.1)/.test(connectionString)
      ? undefined
      : { rejectUnauthorized: false },
  });
  return pool;
}

/** True when at least one read backend is available. */
export function hasReadBackend(): boolean {
  return isConfigured('supabase') || Boolean(getPool());
}

/**
 * Calls a database function by name with positional arguments.
 *
 * The function name is checked against an allow-list rather than interpolated
 * freely — these are the only functions the read path is permitted to invoke.
 */
const CALLABLE = new Set([
  'pcnwatch_hotspots',
  'pcnwatch_location_detail',
  'pcnwatch_map_cells',
]);

export async function callFunction<T>(
  name: string,
  namedArgs: Record<string, unknown>,
  positionalOrder: readonly string[],
): Promise<DbResult<T>> {
  if (!CALLABLE.has(name)) {
    return {
      ok: false,
      correlationId: logError('db.callFunction', new Error(`Function "${name}" is not callable.`)),
      reason: 'NOT_CALLABLE',
    };
  }

  if (isConfigured('supabase')) {
    try {
      const supabase = createSupabaseServiceClient();
      if (supabase) {
        const { data, error } = await supabase.rpc(name, namedArgs);
        if (error) throw error;
        return { ok: true, rows: (data ?? []) as T[], backend: 'supabase' };
      }
    } catch (error) {
      return {
        ok: false,
        correlationId: logError('db.callFunction.supabase', error, { name }),
        reason: 'SUPABASE_ERROR',
      };
    }
  }

  const client = getPool();
  if (!client) {
    return {
      ok: false,
      correlationId: logError('db.callFunction', new Error('No read backend configured.'), { name }),
      reason: 'NOT_CONFIGURED',
    };
  }

  try {
    const values = positionalOrder.map((key) => namedArgs[key] ?? null);
    const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
    const { rows } = await client.query(`select * from ${name}(${placeholders})`, values);
    return { ok: true, rows: rows as T[], backend: 'postgres' };
  } catch (error) {
    return {
      ok: false,
      correlationId: logError('db.callFunction.postgres', error, { name }),
      reason: 'POSTGRES_ERROR',
    };
  }
}

/** A plain query, for the few reads that are not function calls. */
export async function queryRows<T>(sql: string, values: readonly unknown[] = []): Promise<DbResult<T>> {
  const client = getPool();
  if (!client) {
    return {
      ok: false,
      correlationId: logError('db.queryRows', new Error('No Postgres connection configured.')),
      reason: 'NOT_CONFIGURED',
    };
  }
  try {
    const { rows } = await client.query(sql, values as unknown[]);
    return { ok: true, rows: rows as T[], backend: 'postgres' };
  } catch (error) {
    return {
      ok: false,
      correlationId: logError('db.queryRows', error),
      reason: 'POSTGRES_ERROR',
    };
  }
}

/** Test hook: drops the pooled connection so a new DATABASE_URL takes effect. */
export async function __resetPool(): Promise<void> {
  if (pool) await pool.end();
  pool = null;
}
