/**
 * What PCNWatch accepts, named once.
 *
 * Shared between the browser and the server deliberately, because they use it
 * for different things and both need to agree. The browser uses it to set the
 * file picker's filter, so the user is not offered a choice that will be
 * refused. The server uses it to decide what is actually stored.
 *
 * They are not the same check. The browser's is a courtesy and can be skipped
 * by anyone who wants to; the server's is the control. Sharing the list means
 * the courtesy cannot drift out of step with the control, and it does not make
 * the courtesy load-bearing — see server/evidence/upload-validation.ts.
 */

export const ACCEPTED_EVIDENCE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
] as const;

export type AcceptedMediaType = (typeof ACCEPTED_EVIDENCE_TYPES)[number];

/** Matches the bucket's own `file_size_limit` in migration 0006. */
export const MAX_EVIDENCE_BYTES = 12 * 1024 * 1024;

/** Rejects a zero-byte file, which uploads "successfully" and reads as nothing. */
export const MIN_EVIDENCE_BYTES = 64;

export const EXTENSION_FOR: Record<AcceptedMediaType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

export function isAcceptedMediaType(value: string): value is AcceptedMediaType {
  return (ACCEPTED_EVIDENCE_TYPES as readonly string[]).includes(value);
}
