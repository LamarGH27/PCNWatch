import { NextResponse } from 'next/server';
import { rateLimit } from '@/server/rate-limit';
import { logError } from '@/lib/errors';
import { listEvidence, uploadEvidence } from '@/server/evidence/store';
import { EVIDENCE_TYPES, type EvidenceType } from '@/core/evidence/types';

/**
 * Evidence for one case.
 *
 * Validation of the file happens here rather than only in the browser, because
 * a browser check is a convenience for the user and not a control over what
 * arrives. Ownership is not checked here at all: every query runs through the
 * caller's own session, so RLS decides what exists, and a case belonging to
 * somebody else is indistinguishable from one that does not.
 */

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const result = await listEvidence(id);

  if (result.kind === 'NOT_SIGNED_IN') {
    return NextResponse.json({ ok: false, reason: 'NOT_SIGNED_IN' as const }, { status: 401 });
  }
  if (result.kind !== 'OK') {
    return NextResponse.json({ ok: false, reason: 'UNAVAILABLE' as const }, { status: 503 });
  }
  return NextResponse.json({ ok: true as const, items: result.value });
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const limited = await rateLimit(request, { key: 'evidence-upload', limit: 20, windowSeconds: 300 });
  if (!limited.allowed) {
    return NextResponse.json(
      {
        ok: false,
        reason: 'RATE_LIMITED' as const,
        message: `Nothing was lost. Wait ${limited.retryAfterSeconds} seconds and try again.`,
      },
      { status: 429, headers: { 'retry-after': String(limited.retryAfterSeconds) } },
    );
  }

  const { id } = await context.params;

  let file: File | null = null;
  let evidenceType: string | null = null;
  try {
    const form = await request.formData();
    const candidate = form.get('file');
    if (candidate instanceof File) file = candidate;
    const type = form.get('evidenceType');
    if (typeof type === 'string') evidenceType = type;
  } catch (error) {
    // The form itself, never its contents.
    logError('api.evidence.upload.form', error);
  }

  if (!file) {
    return NextResponse.json(
      { ok: false, reason: 'NO_FILE' as const, message: 'No file reached us. Try the upload again.' },
      { status: 400 },
    );
  }
  if (!evidenceType || !(EVIDENCE_TYPES as readonly string[]).includes(evidenceType)) {
    return NextResponse.json(
      {
        ok: false,
        reason: 'BAD_REQUEST' as const,
        message: 'We could not tell what kind of evidence this is. Nothing was saved.',
      },
      { status: 400 },
    );
  }

  const result = await uploadEvidence({
    caseId: id,
    evidenceType: evidenceType as EvidenceType,
    file,
  });

  if (result.kind === 'REJECTED') {
    const status = result.rejection.reason === 'TOO_LARGE' ? 413 : 415;
    return NextResponse.json(
      { ok: false, reason: result.rejection.reason, message: result.rejection.message },
      { status: result.rejection.reason === 'TOO_SMALL' ? 400 : status },
    );
  }
  if (result.kind === 'STORAGE_NOT_READY') {
    /*
     * Refused rather than degraded.
     *
     * Until every storage policy exists, one user's photographs could be
     * readable by another. Accepting the upload anyway and sorting it out later
     * would mean creating that exposure knowingly, so the feature closes
     * instead. `missing` is not returned to the caller — it names our
     * infrastructure, and the person uploading a photograph cannot act on it.
     */
    logError(
      'api.evidence.upload.storageNotReady',
      new Error(`Storage policies missing: ${result.missing.join(', ') || 'unknown'}`),
    );
    return NextResponse.json(
      {
        ok: false,
        reason: 'STORAGE_UNAVAILABLE' as const,
        message:
          'We cannot accept evidence uploads on this deployment yet. Nothing was saved, and the rest of your case is unaffected.',
      },
      { status: 503 },
    );
  }
  if (result.kind === 'NOT_SIGNED_IN') {
    return NextResponse.json({ ok: false, reason: 'NOT_SIGNED_IN' as const }, { status: 401 });
  }
  if (result.kind === 'NOT_FOUND') {
    return NextResponse.json({ ok: false, reason: 'NOT_FOUND' as const }, { status: 404 });
  }
  if (result.kind !== 'OK') {
    return NextResponse.json(
      {
        ok: false,
        reason: 'UNAVAILABLE' as const,
        message: 'Something went wrong while saving your file. Nothing was saved.',
      },
      { status: 503 },
    );
  }

  return NextResponse.json({ ok: true as const, item: result.value }, { status: 201 });
}
