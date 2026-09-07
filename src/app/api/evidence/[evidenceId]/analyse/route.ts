import { NextResponse } from 'next/server';
import { rateLimit } from '@/server/rate-limit';
import { analyseEvidence } from '@/server/evidence/analyse';
import { UNREAD_EVIDENCE_NOTE } from '@/core/evidence/profiles';

/**
 * Reads one uploaded file.
 *
 * Separate from the upload rather than folded into it, so a failure is
 * retryable without asking the user to send their photograph a second time.
 * A failure never loses the file and never moves the case.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ evidenceId: string }> },
) {
  const limited = await rateLimit(request, { key: 'evidence-analyse', limit: 20, windowSeconds: 300 });
  if (!limited.allowed) {
    return NextResponse.json(
      {
        kind: 'FAILED' as const,
        what: 'You have asked us to read several files in a short time.',
        whatYouCanDo: `Nothing was lost. Wait ${limited.retryAfterSeconds} seconds and try again.`,
        fileRetained: true as const,
      },
      { status: 429, headers: { 'retry-after': String(limited.retryAfterSeconds) } },
    );
  }

  const { evidenceId } = await context.params;
  const result = await analyseEvidence(evidenceId);

  if (result.kind === 'NOT_SIGNED_IN') {
    return NextResponse.json({ kind: 'NOT_SIGNED_IN' as const }, { status: 401 });
  }
  if (result.kind === 'NOT_FOUND') {
    return NextResponse.json({ kind: 'NOT_FOUND' as const }, { status: 404 });
  }
  if (result.kind === 'UNAVAILABLE') {
    return NextResponse.json(
      { kind: 'UNAVAILABLE' as const, correlationId: result.correlationId },
      { status: 503 },
    );
  }
  if (result.kind === 'NOT_ANALYSABLE') {
    return NextResponse.json({ kind: 'NOT_ANALYSABLE' as const, item: result.item, note: UNREAD_EVIDENCE_NOTE });
  }
  if (result.kind === 'FAILED') {
    // 200: the request was handled correctly and the outcome is a fact about
    // the file, not an error the client should retry blindly.
    return NextResponse.json(result);
  }
  return NextResponse.json(result);
}
