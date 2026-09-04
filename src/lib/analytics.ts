import { publicEnv } from './env';

/**
 * Product analytics.
 *
 * The hypotheses this exists to test are funnel-shaped (map → analyse → verified
 * extraction → assessment → purchase), so the events are the funnel steps and
 * nothing else.
 *
 * The hard constraint: **no event may ever carry a PCN number, vehicle
 * registration, name, address or document content.** That is not left to the
 * discipline of call sites — the property allow-list below is enforced at send
 * time, and a forbidden key throws in development and is dropped in production.
 */

export const ANALYTICS_EVENTS = [
  'landing_view',
  'map_view',
  'location_search',
  'hotspot_view',
  'pcn_upload_started',
  'pcn_upload_completed',
  'pcn_extraction_verified',
  'assessment_view',
  'checkout_started',
  'checkout_completed',
  'draft_generated',
  'case_closed',
] as const;

export type AnalyticsEvent = (typeof ANALYTICS_EVENTS)[number];

/**
 * The only property names an event may carry.
 *
 * Every one is either a category, a count, a duration or an opaque identifier.
 * Adding a key here is a deliberate, reviewable act — and anything resembling
 * personal data must not be added at all.
 */
export const ALLOWED_PROPERTIES = [
  'authority_slug',
  'location_slug',
  'contravention_code',
  'period_key',
  'score_band',
  'coverage_state',
  'evidence_basis',
  'procedural_stage',
  'notice_category',
  'product_sku',
  'field_count',
  'fields_corrected',
  'evidence_count',
  'result_count',
  'duration_ms',
  'source',
  'flag',
] as const;

export type AllowedProperty = (typeof ALLOWED_PROPERTIES)[number];
export type AnalyticsProperties = Partial<Record<AllowedProperty, string | number | boolean>>;

/**
 * Key fragments that indicate a property must never be sent, whatever it is
 * called. Belt and braces alongside the allow-list.
 */
const FORBIDDEN_FRAGMENTS = [
  'pcn',
  'vrm',
  'vrn',
  'reg',
  'plate',
  'name',
  'address',
  'email',
  'phone',
  'postcode',
  'narrative',
  'document',
  'file',
  'text',
  'body',
  'content',
  'user_id',
] as const;

export class ForbiddenAnalyticsPropertyError extends Error {
  constructor(key: string) {
    super(
      `Analytics property "${key}" is not permitted. Events must never carry personal data or document content.`,
    );
    this.name = 'ForbiddenAnalyticsPropertyError';
  }
}

/**
 * Strips anything not explicitly allowed.
 *
 * In development a forbidden key throws, so it is caught while writing the call
 * site. In production it is dropped silently, because losing an analytics
 * property is always better than leaking one.
 */
export function sanitiseProperties(
  properties: Record<string, unknown>,
  throwOnForbidden = process.env.NODE_ENV !== 'production',
): AnalyticsProperties {
  const allowed = new Set<string>(ALLOWED_PROPERTIES);
  const clean: Record<string, string | number | boolean> = {};

  for (const [key, value] of Object.entries(properties)) {
    const lower = key.toLowerCase();
    const forbidden =
      !allowed.has(key) || FORBIDDEN_FRAGMENTS.some((fragment) => lower.includes(fragment));

    if (forbidden) {
      if (throwOnForbidden) throw new ForbiddenAnalyticsPropertyError(key);
      continue;
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      clean[key] = value;
    }
  }

  return clean as AnalyticsProperties;
}

interface PostHogLike {
  capture: (event: string, properties?: Record<string, unknown>) => void;
}

declare global {
  interface Window {
    posthog?: PostHogLike;
  }
}

/**
 * Sends an event, if analytics is configured at all.
 *
 * A missing PostHog key means no events are sent and nothing throws — analytics
 * is never load-bearing for a user's task.
 */
export function track(event: AnalyticsEvent, properties: AnalyticsProperties = {}): void {
  if (!publicEnv.NEXT_PUBLIC_POSTHOG_KEY) return;
  if (typeof window === 'undefined' || !window.posthog) return;

  try {
    window.posthog.capture(event, sanitiseProperties(properties as Record<string, unknown>, false));
  } catch {
    // Analytics failing must never surface to a user or break a flow.
  }
}

/** Maps a numeric score onto a band, so raw scores never leave as event data. */
export function scoreBand(score: number | null): string {
  if (score === null) return 'unscored';
  if (score <= 19) return 'very_low';
  if (score <= 39) return 'low';
  if (score <= 59) return 'moderate';
  if (score <= 79) return 'high';
  return 'very_high';
}
