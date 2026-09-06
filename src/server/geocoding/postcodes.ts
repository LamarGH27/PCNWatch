import { logError } from '@/lib/errors';

/**
 * UK postcode resolution.
 *
 * Deliberately a narrow interface over one provider rather than a general
 * geocoder. PCNWatch needs exactly one thing here — turn a postcode a user
 * typed into a point to move the map to — and a general geocoder would invite
 * a worse behaviour: returning a confident location for a street we hold no
 * enforcement data about, which reads as coverage we do not have.
 *
 * Provider: postcodes.io. It is free, needs no key, is Open Government Licence
 * data derived from ONS, and is UK-only, which is exactly the scope of the
 * product. No key means no secret to leak and nothing to rotate. It is reached
 * only from the server so a visitor's typing is not sent to a third party from
 * their own browser.
 *
 * Swapping it is a matter of writing another `PostcodeResolver`; nothing above
 * this file knows the provider's name.
 */

export interface ResolvedPostcode {
  readonly postcode: string;
  readonly longitude: number;
  readonly latitude: number;
  /** The administrative district ONS records for it, for the coverage message. */
  readonly district: string | null;
}

export type PostcodeResolution =
  | { readonly kind: 'RESOLVED'; readonly place: ResolvedPostcode }
  | { readonly kind: 'NOT_A_POSTCODE' }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'PROVIDER_UNAVAILABLE' };

export interface PostcodeResolver {
  resolve(input: string): Promise<PostcodeResolution>;
}

/**
 * UK postcode shape.
 *
 * Matches the outward-inward structure without pretending to know which codes
 * exist — that is the provider's job. Accepts any spacing and case, because a
 * user typing on a phone in the street will not produce "NW1 1AA" exactly.
 */
const POSTCODE_PATTERN = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/;

/** Normalises to the canonical "OUTWARD INWARD" form, or null if it is not one. */
export function normalisePostcode(input: string): string | null {
  const compact = input.toUpperCase().replace(/\s+/g, '');
  if (!POSTCODE_PATTERN.test(compact)) return null;
  return `${compact.slice(0, -3)} ${compact.slice(-3)}`;
}

/** True when the input looks like a full postcode rather than a street name. */
export function looksLikePostcode(input: string): boolean {
  return normalisePostcode(input) !== null;
}

const ENDPOINT = 'https://api.postcodes.io/postcodes';

/** Beyond this a lookup is treated as unavailable rather than left hanging. */
const TIMEOUT_MS = 4000;

export class PostcodesIoResolver implements PostcodeResolver {
  async resolve(input: string): Promise<PostcodeResolution> {
    const postcode = normalisePostcode(input);
    if (!postcode) return { kind: 'NOT_A_POSTCODE' };

    try {
      const response = await fetch(`${ENDPOINT}/${encodeURIComponent(postcode)}`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { accept: 'application/json' },
      });

      // A postcode that does not exist is a 404, and is a different answer from
      // the service being down: one is "we looked and it is not real", the
      // other is "we could not look".
      if (response.status === 404) return { kind: 'NOT_FOUND' };
      if (!response.ok) return { kind: 'PROVIDER_UNAVAILABLE' };

      const body = (await response.json()) as {
        result?: {
          postcode?: string;
          longitude?: number | null;
          latitude?: number | null;
          admin_district?: string | null;
        } | null;
      };

      const result = body.result;
      // Some valid postcodes carry no coordinates at all (notably PO boxes and
      // some new-build codes). That is "not found" for the purpose of moving a
      // map, not a provider fault.
      if (
        !result ||
        typeof result.longitude !== 'number' ||
        typeof result.latitude !== 'number'
      ) {
        return { kind: 'NOT_FOUND' };
      }

      return {
        kind: 'RESOLVED',
        place: {
          postcode: result.postcode ?? postcode,
          longitude: result.longitude,
          latitude: result.latitude,
          district: result.admin_district ?? null,
        },
      };
    } catch (error) {
      // Never surfaces the postcode: the log records that a lookup failed, not
      // what someone was looking for.
      logError('geocoding.postcodes', error);
      return { kind: 'PROVIDER_UNAVAILABLE' };
    }
  }
}

let resolver: PostcodeResolver = new PostcodesIoResolver();

export function getPostcodeResolver(): PostcodeResolver {
  return resolver;
}

/** Test seam, and the single point a different provider would be installed at. */
export function setPostcodeResolver(next: PostcodeResolver): void {
  resolver = next;
}

export function resetPostcodeResolver(): void {
  resolver = new PostcodesIoResolver();
}
