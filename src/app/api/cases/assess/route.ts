import { NextResponse } from 'next/server';
import { logError } from '@/lib/errors';
import { rateLimit } from '@/server/rate-limit';
import { assessVerifiedNotice, type VerifiedFacts } from '@/server/cases/assess-verified';
import { reconcileContext } from '@/core/context/reconcile';
import { caseFieldsSchema } from '../schema';
import type { UserContext } from '@/core/context/types';

/**
 * The free assessment for a set of confirmed facts.
 *
 * Runs on the server because the reference store and the rules engines live
 * there. It stores nothing itself — the case is saved by POST /api/cases before
 * this is called, so an assessment that fails cannot cost the user the details
 * they just confirmed. What comes back is recomputed from those facts every
 * time and never read from a row.
 *
 * No model is called. The contravention's meaning comes from the approved
 * reference store or is reported as absent; deadlines come from the deadline
 * engine or are refused. Neither is ever generated.
 */

export async function POST(request: Request) {
  const limited = await rateLimit(request, { key: 'case-assess', limit: 30, windowSeconds: 60 });
  if (!limited.allowed) {
    return NextResponse.json(
      { ok: false, reason: 'RATE_LIMITED' as const },
      { status: 429 },
    );
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ ok: false, reason: 'BAD_REQUEST' as const }, { status: 400 });
  }

  const parsed = caseFieldsSchema.safeParse(raw);
  if (!parsed.success) {
    // The notice details are never logged — only that validation failed.
    logError('api.cases.assess.validation', new Error('Verified facts failed validation.'));
    return NextResponse.json({ ok: false, reason: 'BAD_REQUEST' as const }, { status: 400 });
  }

  try {
    const { context, ...facts } = parsed.data;

    /*
     * An assessment is not produced while the user's own facts contradict
     * each other.
     *
     * The engine already excludes a disputed topic, so proceeding would be
     * safe in the narrow sense — but it would also be an assessment quietly
     * built on less than the user thinks they told us, and the contradiction
     * would still be sitting in their answers. Refusing here means the choice
     * is put to them once, in front of the thing it affects.
     *
     * Enforced on the server rather than in the flow because this endpoint is
     * the boundary: a stale client, a retry, or anything else calling it
     * directly gets the same answer.
     */
    if (context) {
      const { conflicts } = reconcileContext(
        context.answers,
        context.confirmedAssertions,
        context.resolvedFacts,
      );
      if (conflicts.length > 0) {
        return NextResponse.json(
          { ok: false as const, reason: 'UNRESOLVED_CONFLICT' as const, conflicts },
          { status: 409 },
        );
      }
    }

    return NextResponse.json({
      ok: true as const,
      assessment: assessVerifiedNotice(
        facts as VerifiedFacts,
        context as UserContext | undefined,
      ),
    });
  } catch (error) {
    logError('api.cases.assess', error);
    return NextResponse.json({ ok: false, reason: 'UNAVAILABLE' as const }, { status: 503 });
  }
}
