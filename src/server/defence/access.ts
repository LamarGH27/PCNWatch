import { featureFlags } from '@/lib/env';
import { requireEntitlement } from '@/server/payments/entitlements';

/**
 * Who may have a Defence Pack.
 *
 * Two doors, and only one of them is meant to be open in Production.
 *
 * The entitlement is the real one: a row written by the Stripe webhook, which
 * `requireEntitlement` reads and nothing else can forge. That path is already
 * built and stays exactly as it was.
 *
 * The other is the preview flag, which exists because this is a paid product
 * with no payment attached yet and it has to be usable somewhere. The danger it
 * creates is obvious and specific: an environment variable copied from Preview
 * to Production, and the premium product is permanently free with nobody
 * noticing. So the flag is refused outright in a production build. Both
 * conditions have to be wrong at once for that to happen, and one of them is
 * not an environment variable anybody can copy.
 */

export type PackAccess =
  | { readonly granted: true; readonly via: 'ENTITLEMENT' | 'PREVIEW_FLAG' }
  | { readonly granted: false; readonly reason: string };

/**
 * Whether the preview door is open at all.
 *
 * This asked `NODE_ENV !== 'production'` and was wrong about the one deployment
 * it existed for. Vercel builds Preview with `next build`, which sets
 * `NODE_ENV=production` exactly as it does for Production — so the conjunct was
 * statically false, webpack removed the whole branch from the emitted bundle,
 * and setting the flag in Preview did nothing at all. The guarantee held; the
 * feature it was guarding never opened.
 *
 * `VERCEL_ENV` is the variable that actually distinguishes the two. It is
 * server-side and read at runtime rather than inlined at build, which is also
 * why this function is called rather than a constant captured at module load.
 *
 * The Vercel branch is explicit about wanting `preview` rather than merely
 * not-`production`. The difference matters if Vercel ever adds a third value:
 * "anything except production" would silently open the door to it, and
 * "exactly preview" would not.
 */
export function previewAccessAvailable(): boolean {
  if (process.env.VERCEL_ENV) {
    return featureFlags.defencePackPreview && process.env.VERCEL_ENV === 'preview';
  }

  // Off Vercel — local development, `next dev`, the test suite. The original
  // check, which is correct everywhere it was ever actually consulted.
  return featureFlags.defencePackPreview && process.env.NODE_ENV !== 'production';
}

export async function defencePackAccess(
  userId: string | undefined,
  caseId: string,
): Promise<PackAccess> {
  if (!userId) {
    return { granted: false, reason: 'You need to be signed in to build a Defence Pack.' };
  }

  const entitlement = await requireEntitlement(userId, caseId, 'CHALLENGE_DRAFT');
  if (entitlement.granted) return { granted: true, via: 'ENTITLEMENT' };

  if (previewAccessAvailable()) return { granted: true, via: 'PREVIEW_FLAG' };

  return { granted: false, reason: entitlement.reason };
}
