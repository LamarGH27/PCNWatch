import { NextResponse } from 'next/server';
import { createSupabaseServerClient, createSupabaseServiceClient } from '@/lib/supabase/server';
import { defencePackAccess } from '@/server/defence/access';
import { logError } from '@/lib/errors';

/**
 * What this user currently holds on this case.
 *
 * Exists so the page a Stripe redirect lands on can find out whether the
 * webhook has arrived. The redirect itself proves nothing — that is the whole
 * design — so the page needs somewhere to ask, and this is it.
 *
 * The answer is read from persisted rows via `defencePackAccess`. There is no
 * parameter through which a caller can influence it, and nothing here writes.
 */

export const dynamic = 'force-dynamic';

type AttemptState = 'NONE' | 'PENDING' | 'FAILED';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ ok: false, reason: 'BAD_REQUEST' as const }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return NextResponse.json({ ok: false, reason: 'UNAVAILABLE' as const }, { status: 503 });
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, reason: 'NOT_SIGNED_IN' as const }, { status: 401 });
  }

  /*
   * Read through the caller's own session, so RLS decides whether this case is
   * theirs. Without it, polling a case id you do not own would tell you whether
   * somebody else had paid for it.
   */
  const { data: ownedCase } = await supabase
    .from('pcn_cases')
    .select('id')
    .eq('id', id)
    .maybeSingle();
  if (!ownedCase) {
    return NextResponse.json({ ok: false, reason: 'NOT_FOUND' as const }, { status: 404 });
  }

  const access = await defencePackAccess(user.id, id);

  /*
   * Whether an attempt is still in flight, which is what separates "wait a
   * moment" from "something went wrong". Purely advisory: it never grants, and
   * a failure to read it leaves the user with the entitlement answer, which is
   * the one that matters.
   */
  let attempt: AttemptState = 'NONE';
  try {
    const service = createSupabaseServiceClient();
    if (service) {
      const { data } = await service
        .from('payments')
        .select('status')
        .eq('user_id', user.id)
        .eq('case_id', id)
        .in('status', ['PENDING', 'FAILED'])
        .order('created_at', { ascending: false })
        .limit(1);
      const status = data?.[0]?.status;
      if (status === 'PENDING' || status === 'FAILED') attempt = status;
    }
  } catch (error) {
    logError('api.entitlement.attempt', error, { caseId: id });
  }

  return NextResponse.json({
    ok: true as const,
    entitled: access.granted,
    via: access.granted ? access.via : null,
    attempt,
  });
}
