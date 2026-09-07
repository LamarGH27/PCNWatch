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
 * `NODE_ENV` is set to production by `next build` for the deployed bundle, so
 * this is false in Production regardless of what the flag says. Read at call
 * time rather than at module load so a test can exercise both branches.
 */
export function previewAccessAvailable(): boolean {
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
