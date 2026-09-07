import { NextResponse } from 'next/server';
import { deleteEvidence } from '@/server/evidence/store';

/**
 * Deleting one item.
 *
 * The row goes first and the object follows. If the object delete fails the
 * file is orphaned in a bucket nobody can list — which is a tidiness problem,
 * where the other order would leave a live row pointing at nothing and a page
 * that cannot render.
 *
 * The case is not in this path. It would read as scoping and would not be any:
 * the row is found through the caller's own session, so RLS already decides
 * that this item is theirs, and adding a case id would only let a caller pass
 * one that does not match.
 */
export async function DELETE(
  _request: Request,
  context: { params: Promise<{ evidenceId: string }> },
) {
  const { evidenceId } = await context.params;
  const result = await deleteEvidence(evidenceId);

  if (result.kind === 'NOT_SIGNED_IN') {
    return NextResponse.json({ ok: false, reason: 'NOT_SIGNED_IN' as const }, { status: 401 });
  }
  if (result.kind === 'NOT_FOUND') {
    return NextResponse.json({ ok: false, reason: 'NOT_FOUND' as const }, { status: 404 });
  }
  if (result.kind !== 'OK') {
    return NextResponse.json({ ok: false, reason: 'UNAVAILABLE' as const }, { status: 503 });
  }
  return NextResponse.json({ ok: true as const });
}
