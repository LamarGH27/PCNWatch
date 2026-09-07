import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getEvidence, recordVerification } from '@/server/evidence/store';
import { verifiedFactsFrom } from '@/core/evidence/verification';
import type { EvidenceAnalysis } from '@/core/evidence/analysis';

/**
 * The user confirming what we read.
 *
 * The body carries positions, not values. A caller cannot post a reading into
 * their own case: the indexes are resolved against the analysis we stored, and
 * anything that does not point at a readable observation produces nothing. What
 * becomes a fact is the text we read and showed them, never the text the
 * browser sent back.
 *
 * An empty list is a real answer and is accepted. It means the user looked at
 * the readings and rejected all of them — their document does not say what we
 * thought — and an item verified with no facts supports nothing.
 */
const bodySchema = z.object({
  confirmed: z.array(z.number().int().min(0).max(19)).max(20),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ evidenceId: string }> },
) {
  const { evidenceId } = await context.params;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ ok: false, reason: 'BAD_REQUEST' as const }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, reason: 'BAD_REQUEST' as const }, { status: 400 });
  }

  const current = await getEvidence(evidenceId);
  if (current.kind === 'NOT_SIGNED_IN') {
    return NextResponse.json({ ok: false, reason: 'NOT_SIGNED_IN' as const }, { status: 401 });
  }
  if (current.kind === 'NOT_FOUND') {
    return NextResponse.json({ ok: false, reason: 'NOT_FOUND' as const }, { status: 404 });
  }
  if (current.kind !== 'OK') {
    return NextResponse.json({ ok: false, reason: 'UNAVAILABLE' as const }, { status: 503 });
  }

  const analysis = current.value.analysis;
  if (current.value.status !== 'ANALYSED' || !analysis) {
    // Nothing has been read, so there is nothing to agree with. Confirming an
    // item at this point would be the user vouching for readings that do not
    // exist, which is exactly the shortcut the lifecycle exists to prevent.
    return NextResponse.json({ ok: false, reason: 'NOTHING_TO_CONFIRM' as const }, { status: 409 });
  }

  const facts = verifiedFactsFrom(analysis as EvidenceAnalysis, parsed.data.confirmed);
  const result = await recordVerification(evidenceId, facts);

  if (result.kind === 'NOT_SIGNED_IN') {
    return NextResponse.json({ ok: false, reason: 'NOT_SIGNED_IN' as const }, { status: 401 });
  }
  if (result.kind === 'NOT_FOUND') {
    return NextResponse.json({ ok: false, reason: 'NOTHING_TO_CONFIRM' as const }, { status: 409 });
  }
  if (result.kind !== 'OK') {
    return NextResponse.json({ ok: false, reason: 'UNAVAILABLE' as const }, { status: 503 });
  }

  return NextResponse.json({ ok: true as const, item: result.value });
}
