import { NextResponse } from 'next/server';
import { rateLimit } from '@/server/rate-limit';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { getCase } from '@/server/repositories/cases';
import { buildCaseView } from '@/server/cases/case-view';
import { buildDefencePack } from '@/server/defence/build';
import { defencePackAccess } from '@/server/defence/access';
import { DEFENCE_PACK_ENGINE_VERSION, draftChallenge } from '@/server/defence/generate';
import { fingerprintCase } from '@/server/defence/fingerprint';
import { loadPack, savePack } from '@/server/defence/persist';

/**
 * Building a Defence Pack.
 *
 * The order is the product. The deterministic pack is built first, from the
 * record; the letter is drafted from the pack; and only then is anything
 * stored. A letter that fails validation costs the user the letter and nothing
 * else — the pack is still built, still saved, and any letter they already had
 * is left where it was.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const limited = await rateLimit(request, { key: 'defence-pack', limit: 10, windowSeconds: 300 });
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

  const supabase = await createSupabaseServerClient();
  const userId = supabase ? (await supabase.auth.getUser()).data.user?.id : undefined;

  const access = await defencePackAccess(userId, id);
  if (!access.granted) {
    return NextResponse.json(
      { ok: false, reason: 'NOT_ENTITLED' as const, message: access.reason },
      { status: 402 },
    );
  }

  const found = await getCase(id);
  if (found.kind === 'NOT_SIGNED_IN') {
    return NextResponse.json({ ok: false, reason: 'NOT_SIGNED_IN' as const }, { status: 401 });
  }
  if (found.kind === 'NOT_FOUND') {
    return NextResponse.json({ ok: false, reason: 'NOT_FOUND' as const }, { status: 404 });
  }
  if (found.kind !== 'FOUND') {
    return NextResponse.json({ ok: false, reason: 'UNAVAILABLE' as const }, { status: 503 });
  }

  const record = found.record;
  const view = buildCaseView(record, new Date().toISOString().slice(0, 10));

  if (view.outOfScopeMessage) {
    // We will not produce a document that applies the wrong process to a notice.
    return NextResponse.json(
      { ok: false, reason: 'OUT_OF_SCOPE' as const, message: view.outOfScopeMessage },
      { status: 409 },
    );
  }

  const fingerprints = fingerprintCase(record);
  const existing = await loadPack(id, fingerprints);
  const previousVersion =
    existing.kind === 'OK' && existing.value ? existing.value.version : 0;

  const pack = buildDefencePack(record, view);
  const drafted = await draftChallenge(pack, id);

  const saved = await savePack({
    caseId: id,
    pack,
    // A failed letter stores the pack with an empty body rather than a partial
    // one. Half a letter that reads like a whole letter is the dangerous shape.
    draft: drafted.kind === 'DRAFTED' ? drafted.draft : null,
    fingerprints,
    engineVersion: DEFENCE_PACK_ENGINE_VERSION,
    previousVersion,
  });

  if (saved.kind === 'NOT_SIGNED_IN') {
    return NextResponse.json({ ok: false, reason: 'NOT_SIGNED_IN' as const }, { status: 401 });
  }
  if (saved.kind !== 'OK') {
    return NextResponse.json(
      {
        ok: false,
        reason: 'UNAVAILABLE' as const,
        message:
          'We built your Defence Pack and could not save it. Your case and evidence are unchanged.',
      },
      { status: 503 },
    );
  }

  /*
   * A Pack whose letter did not generate is not a finished product.
   *
   * `ok` used to be true whenever the sections saved, so the UI presented a
   * £5.99 deliverable with its headline item missing and no indication that
   * anything had gone wrong. The status now says which of the three things
   * happened, and the client renders the difference.
   */
  return NextResponse.json({
    ok: true as const,
    status: saved.value.status,
    pack: saved.value,
    letter:
      drafted.kind === 'DRAFTED'
        ? { drafted: true as const }
        : { drafted: false as const, what: drafted.what, whatYouCanDo: drafted.whatYouCanDo },
  });
}
