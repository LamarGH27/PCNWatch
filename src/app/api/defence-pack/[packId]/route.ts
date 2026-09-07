import { NextResponse } from 'next/server';
import { z } from 'zod';
import { saveEditedBody } from '@/server/defence/persist';

/**
 * The user's edited letter.
 *
 * One field, and deliberately nothing else. The authoritative half of a
 * Defence Pack — the notice facts, the evidence facts, the findings — has no
 * route through this endpoint, so an edit cannot reach it by any request a
 * client could construct. Presentation and record are separated by there being
 * no code that writes both.
 */
const bodySchema = z.object({
  editedBody: z.string().max(20_000),
});

export async function PATCH(
  request: Request,
  context: { params: Promise<{ packId: string }> },
) {
  const { packId } = await context.params;

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

  const result = await saveEditedBody(packId, parsed.data.editedBody);

  if (result.kind === 'NOT_SIGNED_IN') {
    return NextResponse.json({ ok: false, reason: 'NOT_SIGNED_IN' as const }, { status: 401 });
  }
  if (result.kind === 'NOT_FOUND') {
    // RLS matched no row. Indistinguishable from a pack that does not exist,
    // which is what stops an id in the URL being a way to find other people's.
    return NextResponse.json({ ok: false, reason: 'NOT_FOUND' as const }, { status: 404 });
  }
  if (result.kind !== 'OK') {
    return NextResponse.json({ ok: false, reason: 'UNAVAILABLE' as const }, { status: 503 });
  }

  return NextResponse.json({ ok: true as const, pack: result.value });
}
