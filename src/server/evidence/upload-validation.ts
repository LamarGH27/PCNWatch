/**
 * What may be uploaded, decided on the server.
 *
 * The browser's `accept` attribute and any client-side size check are
 * conveniences for the user. They are not controls: a request reaches this
 * endpoint over HTTP and nothing about it is trustworthy, including the
 * content type the client claims. So the checks run here, and the bucket
 * carries its own MIME allowlist and size limit underneath as a third line —
 * three independent places that must all agree before a byte is stored.
 *
 * The list is an allowlist and stays one. There is no branch that accepts an
 * unrecognised type "just in case it is a photo": a format we cannot read is a
 * format we would be storing blind, and executables, archives and office
 * documents have no place in a bucket of parking photographs.
 */

import {
  ACCEPTED_EVIDENCE_TYPES,
  EXTENSION_FOR,
  MAX_EVIDENCE_BYTES,
  MIN_EVIDENCE_BYTES,
  isAcceptedMediaType,
  type AcceptedMediaType,
} from '@/core/evidence/upload-limits';

export { ACCEPTED_EVIDENCE_TYPES, MAX_EVIDENCE_BYTES, MIN_EVIDENCE_BYTES };
export type { AcceptedMediaType };

export type UploadRejection =
  | { readonly reason: 'UNSUPPORTED_TYPE'; readonly message: string }
  | { readonly reason: 'TOO_LARGE'; readonly message: string }
  | { readonly reason: 'TOO_SMALL'; readonly message: string };

export type UploadValidation =
  | { readonly ok: true; readonly mediaType: AcceptedMediaType }
  | { readonly ok: false; readonly rejection: UploadRejection };

export function validateUpload(file: { type: string; size: number }): UploadValidation {
  if (!isAcceptedMediaType(file.type)) {
    return {
      ok: false,
      rejection: {
        reason: 'UNSUPPORTED_TYPE',
        message: `We cannot accept files of type "${file.type || 'unknown'}". Upload a JPG, PNG, WebP or PDF.`,
      },
    };
  }
  if (file.size > MAX_EVIDENCE_BYTES) {
    return {
      ok: false,
      rejection: {
        reason: 'TOO_LARGE',
        message: 'That file is larger than we accept. Take the photo again at a lower resolution.',
      },
    };
  }
  if (file.size < MIN_EVIDENCE_BYTES) {
    return {
      ok: false,
      rejection: {
        reason: 'TOO_SMALL',
        message: 'That file is empty or truncated. Try the upload again.',
      },
    };
  }
  return { ok: true, mediaType: file.type };
}

/**
 * Where the object lives in the bucket.
 *
 * `<user_id>/<case_id>/<random>.<ext>` — the first segment is what the storage
 * policies check, so the path itself carries the ownership the policy enforces.
 *
 * Nothing from the user's filename survives into it. A filename is attacker
 * controlled and would otherwise reach a path, a log line and an object key;
 * it is kept as a column for the user to recognise their own file by, and
 * never used to address anything.
 */
export function evidenceObjectPath(
  userId: string,
  caseId: string,
  mediaType: AcceptedMediaType,
  randomId: string,
): string {
  return `${userId}/${caseId}/${randomId}.${EXTENSION_FOR[mediaType]}`;
}
