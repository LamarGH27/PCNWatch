import { createHash } from 'node:crypto';
import { createSupabaseServiceClient } from '@/lib/supabase/server';
import { isConfigured } from '@/lib/env';
import { logError } from '@/lib/errors';

/**
 * Fixed-window rate limiting for expensive endpoints.
 *
 * Backed by a database counter so it holds across serverless instances. An
 * in-process fallback covers local development and the case where the database
 * is briefly unreachable.
 *
 * Design choice: on backend failure we ALLOW the request. Rate limiting protects
 * cost and abuse, not correctness or security — failing closed would turn a
 * transient database blip into a total outage. Anything where refusal actually
 * matters (payments, entitlements) is enforced by RLS and constraints instead.
 */

export interface RateLimitOptions {
  /** Logical bucket, e.g. "map-cells". Keeps limits independent per endpoint. */
  readonly key: string;
  readonly limit: number;
  readonly windowSeconds: number;
  /** Overrides the derived caller identity, e.g. a user id for signed-in limits. */
  readonly identity?: string;
}

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly retryAfterSeconds: number;
}

const memoryCounters = new Map<string, { count: number; windowStart: number }>();

/**
 * Derives a caller identity from proxy headers.
 *
 * Hashed before it is stored, so the counter table never holds a raw IP address.
 */
export function callerIdentity(request: Request): string {
  const headers = request.headers;
  const forwarded = headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const raw = forwarded || headers.get('x-real-ip') || headers.get('cf-connecting-ip') || 'unknown';
  return createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

export async function rateLimit(
  request: Request,
  options: RateLimitOptions,
): Promise<RateLimitResult> {
  const identity = options.identity ?? callerIdentity(request);
  const windowMs = options.windowSeconds * 1000;
  const windowStart = Math.floor(Date.now() / windowMs) * windowMs;
  const bucketKey = `${options.key}:${identity}`;
  const retryAfterSeconds = Math.ceil((windowStart + windowMs - Date.now()) / 1000);

  if (!isConfigured('supabase')) {
    return memoryLimit(bucketKey, windowStart, options.limit, retryAfterSeconds);
  }

  try {
    const supabase = createSupabaseServiceClient();
    if (!supabase) return memoryLimit(bucketKey, windowStart, options.limit, retryAfterSeconds);

    const { data, error } = await supabase.rpc('pcnwatch_bump_rate_limit', {
      p_key: bucketKey,
      p_window_start: new Date(windowStart).toISOString(),
    });
    if (error) throw error;

    const count = Number(data ?? 0);
    return {
      allowed: count <= options.limit,
      remaining: Math.max(0, options.limit - count),
      retryAfterSeconds,
    };
  } catch (error) {
    logError('rateLimit', error, { key: options.key });
    // Fail open, deliberately — see the note at the top of this file.
    return memoryLimit(bucketKey, windowStart, options.limit, retryAfterSeconds);
  }
}

function memoryLimit(
  bucketKey: string,
  windowStart: number,
  limit: number,
  retryAfterSeconds: number,
): RateLimitResult {
  const existing = memoryCounters.get(bucketKey);
  const count = existing && existing.windowStart === windowStart ? existing.count + 1 : 1;
  memoryCounters.set(bucketKey, { count, windowStart });

  // Keep the map from growing without bound in a long-lived process.
  if (memoryCounters.size > 10_000) {
    for (const [key, value] of memoryCounters) {
      if (value.windowStart < windowStart) memoryCounters.delete(key);
    }
  }

  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    retryAfterSeconds,
  };
}

/** Test hook. */
export function __resetRateLimitMemory(): void {
  memoryCounters.clear();
}
