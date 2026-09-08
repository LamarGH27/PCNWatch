import Link from 'next/link';
import { getCase } from '@/server/repositories/cases';
import { buildCaseView } from '@/server/cases/case-view';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { defencePackAccess } from '@/server/defence/access';
import { fingerprintCase } from '@/server/defence/fingerprint';
import { loadPack } from '@/server/defence/persist';
import { getProduct } from '@/server/payments/catalogue';
import { featureFlags } from '@/lib/env';
import { Card, Disclaimer, formatPence } from '@/components/primitives';
import { CaseUnavailable } from '../CaseUnavailable';
import { DefencePanel, type StoredPackView } from './DefencePanel';
import { PurchaseCta } from './PurchaseCta';

export default async function DefencePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const query = await searchParams;

  /*
   * Where the user came from, and nothing more.
   *
   * `?checkout=returned` says a browser was redirected here. It is not proof of
   * payment — anyone can type it — so it only ever decides which sentence to
   * show while the server is asked what the user actually holds.
   */
  const rawReturn = Array.isArray(query.checkout) ? query.checkout[0] : query.checkout;
  const returnState =
    rawReturn === 'returned' ? 'returned' : rawReturn === 'cancelled' ? 'cancelled' : null;
  const result = await getCase(id);
  if (result.kind !== 'FOUND') {
    return (
      <CaseUnavailable
        kind={result.kind}
        correlationId={result.kind === 'UNAVAILABLE' ? result.correlationId : undefined}
      />
    );
  }

  const record = result.record;
  const view = buildCaseView(record, new Date().toISOString().slice(0, 10));

  const supabase = await createSupabaseServerClient();
  const userId = supabase ? (await supabase.auth.getUser()).data.user?.id : undefined;
  const access = await defencePackAccess(userId, id);

  const stored = access.granted
    ? await loadPack(id, fingerprintCase(record))
    : ({ kind: 'OK', value: null } as const);
  const pack = stored.kind === 'OK' ? stored.value : null;

  const product = getProduct('PCNWATCH_DEFENCE');

  return (
    <div className="fr-container fr-pack" style={{ paddingBlock: 28, maxWidth: 820 }}>
      <nav aria-label="Breadcrumb" style={{ fontSize: 13, marginBottom: 12 }} className="fr-no-print">
        <Link href={`/case/${id}`} style={{ color: 'var(--text-muted)' }}>
          ← Back to case
        </Link>
      </nav>

      <h1 style={{ fontSize: 'clamp(23px, 3.4vw, 32px)', fontWeight: 630 }}>Defence Pack</h1>
      <p style={{ marginTop: 10, color: 'var(--text-muted)', fontSize: 16, maxWidth: 640 }}>
        Everything on this case, put together as something you can send. Built from the notice
        details you confirmed, what you told us, and the evidence you have checked.
      </p>

      {view.outOfScopeMessage ? (
        <Card style={{ marginTop: 20 }}>
          <strong style={{ fontSize: 15 }}>{view.outOfScopeMessage}</strong>
          <p style={{ margin: '8px 0 0', fontSize: 14.5, color: 'var(--text-muted)' }}>
            We will not produce a document that applies the wrong process to your notice.
          </p>
        </Card>
      ) : !access.granted ? (
        <Card style={{ marginTop: 20 }}>
          <div className="fr-eyebrow" style={{ marginBottom: 8 }}>
            Defence Pack
          </div>
          <h2 style={{ fontSize: 19, fontWeight: 620, marginBottom: 8 }}>
            {product ? formatPence(product.pricePence) : ''} one-off
          </h2>
          <p style={{ margin: '0 0 14px', fontSize: 15, color: 'var(--text-muted)' }}>
            {access.reason}
          </p>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 14.5, color: 'var(--text-muted)' }}>
            {product?.includes.map((line) => <li key={line}>{line}</li>)}
          </ul>
          <PurchaseCta
            caseId={id}
            priceLabel={product ? formatPence(product.pricePence) : ''}
            paymentsEnabled={featureFlags.payments}
            returnState={returnState}
          />
          <p style={{ margin: '16px 0 0', fontSize: 13.5, color: 'var(--text-faint)' }}>
            Your deadlines, the evidence checklist and the evidence basis stay free.
          </p>
        </Card>
      ) : (
        /*
         * No basis gate.
         *
         * A pack is buildable even where the evidence basis is INSUFFICIENT —
         * the sections that matter most to somebody in that position are the
         * weaknesses and the checklist, and refusing to build would withhold
         * exactly the advice they need. The pack says how thin it is; it does
         * not decline to exist.
         */
        <DefencePanel caseId={id} initial={pack as StoredPackView | null} />
      )}

      <div style={{ marginTop: 28 }} className="fr-no-print">
        <Disclaimer />
      </div>
    </div>
  );
}
