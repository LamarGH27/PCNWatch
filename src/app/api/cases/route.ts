import { NextResponse } from 'next/server';
import { logError } from '@/lib/errors';
import { rateLimit } from '@/server/rate-limit';
import { saveCase } from '@/server/cases/persist';
import type { VerifiedFacts } from '@/server/cases/assess-verified';
import { EMPTY_USER_CONTEXT, type UserContext } from '@/core/context/types';
import { caseBodySchema } from './schema';

/**
 * Saving the case.
 *
 * Called after the user has confirmed their notice and their context, and
 * before the assessment is produced. That order is the point: an assessment
 * that fails must not cost somebody the fourteen fields they just checked, so
 * the save happens first and the assessment is attempted against a case that
 * already exists.
 *
 * The owner is not a parameter. `user_id` defaults to `auth.uid()` in the
 * database and RLS checks the same value, so this endpoint cannot attribute a
 * case to anybody but its caller — not by mistake and not by a crafted request.
 */

export async function POST(request: Request) {
  const limited = await rateLimit(request, { key: 'case-save', limit: 30, windowSeconds: 60 });
  if (!limited.allowed) {
    return NextResponse.json(
      { ok: false, reason: 'RATE_LIMITED' as const },
      { status: 429, headers: { 'retry-after': String(limited.retryAfterSeconds) } },
    );
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ ok: false, reason: 'BAD_REQUEST' as const }, { status: 400 });
  }

  const parsed = caseBodySchema.safeParse(raw);
  if (!parsed.success) {
    // Nothing from the notice reaches the log — only that validation failed.
    logError('api.cases.save.validation', new Error('Case failed validation.'));
    return NextResponse.json({ ok: false, reason: 'BAD_REQUEST' as const }, { status: 400 });
  }

  const { context, caseId, ...facts } = parsed.data;

  const result = await saveCase(
    facts as VerifiedFacts,
    (context as UserContext | undefined) ?? EMPTY_USER_CONTEXT,
    caseId,
  );

  if (result.kind === 'NOT_SIGNED_IN') {
    /*
     * Also the answer for an update aimed at a case the caller does not own.
     * RLS returns no row in that case, which is indistinguishable from a case
     * that does not exist — and telling the two apart is precisely what would
     * let somebody probe for other people's case ids.
     */
    return NextResponse.json({ ok: false, reason: 'NOT_SIGNED_IN' as const }, { status: 401 });
  }
  if (result.kind === 'UNAVAILABLE') {
    return NextResponse.json({ ok: false, reason: 'UNAVAILABLE' as const }, { status: 503 });
  }

  return NextResponse.json({ ok: true as const, caseId: result.caseId });
}

