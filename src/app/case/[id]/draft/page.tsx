import Link from 'next/link';
import { getCase } from '@/server/repositories/cases';
import { buildCaseView } from '@/server/cases/case-view';
import { requireEntitlement } from '@/server/payments/entitlements';
import { getProduct } from '@/server/payments/catalogue';
import { featureFlags } from '@/lib/env';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { Card, Disclaimer, formatPence } from '@/components/primitives';
import { CaseUnavailable } from '../CaseUnavailable';

/**
 * The challenge draft.
 *
 * The order here is the point: rules and evidence are assessed first, and the
 * draft is only offered once there is something for it to be grounded in. A
 * generated document is never the first thing a user sees.
 */
export default async function DraftPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await getCase(id);
  if (result.kind !== 'FOUND') {
    return (
      <CaseUnavailable
        kind={result.kind}
        correlationId={result.kind === 'UNAVAILABLE' ? result.correlationId : undefined}
      />
    );
  }

  const view = buildCaseView(result.record, new Date().toISOString().slice(0, 10));

  const supabase = await createSupabaseServerClient();
  const userId = supabase ? (await supabase.auth.getUser()).data.user?.id : undefined;
  const entitlement = userId
    ? await requireEntitlement(userId, id, 'CHALLENGE_DRAFT')
    : { granted: false, entitlement: 'CHALLENGE_DRAFT' as const, reason: 'Not signed in.' };

  const product = getProduct('PCNWATCH_DEFENCE');

  return (
    <div className="fr-container" style={{ paddingBlock: 28, maxWidth: 800 }}>
      <nav aria-label="Breadcrumb" style={{ fontSize: 13, marginBottom: 12 }}>
        <Link href={`/case/${id}`} style={{ color: 'var(--text-muted)' }}>
          ← Back to case
        </Link>
      </nav>

      <h1 style={{ fontSize: 'clamp(23px, 3.4vw, 32px)', fontWeight: 630 }}>Challenge draft</h1>

      {view.outOfScopeMessage ? (
        <Card style={{ marginTop: 20 }}>
          <strong style={{ fontSize: 15 }}>{view.outOfScopeMessage}</strong>
          <p style={{ margin: '8px 0 0', fontSize: 14.5, color: 'var(--text-muted)' }}>
            We will not generate a document that applies the wrong process to your notice.
          </p>
        </Card>
      ) : view.assessment.basis === 'INSUFFICIENT_INFORMATION' ? (
        <Card style={{ marginTop: 20 }}>
          <h2 style={{ fontSize: 17, fontWeight: 620, marginBottom: 8 }}>
            There is not enough here to draft from yet
          </h2>
          <p style={{ margin: 0, fontSize: 15, color: 'var(--text-muted)' }}>
            {view.assessment.basisExplanation}
          </p>
          {view.assessment.missingInformation.length > 0 && (
            <ul
              style={{
                margin: '14px 0 0',
                paddingLeft: 18,
                fontSize: 14,
                color: 'var(--text-muted)',
                display: 'grid',
                gap: 5,
              }}
            >
              {view.assessment.missingInformation.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          )}
          <p style={{ marginTop: 16 }}>
            <Link href={`/case/${id}/assessment`}>See what is missing →</Link>
          </p>
        </Card>
      ) : !entitlement.granted ? (
        <>
          <Card style={{ marginTop: 20 }}>
            <div className="fr-eyebrow" style={{ marginBottom: 8 }}>
              Defence Pack
            </div>
            <h2 style={{ fontSize: 19, fontWeight: 620, marginBottom: 8 }}>
              {product ? formatPence(product.pricePence) : ''} one-off
            </h2>
            <p style={{ margin: '0 0 14px', fontSize: 15, color: 'var(--text-muted)' }}>
              {product?.description}
            </p>
            <ul style={{ margin: '0 0 18px', paddingLeft: 18, fontSize: 14.5, color: 'var(--text-muted)' }}>
              {product?.includes.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>

            {featureFlags.payments ? (
              <form action={`/api/checkout?case=${id}&sku=PCNWATCH_DEFENCE`} method="post">
                <button
                  type="submit"
                  className="fr-touch"
                  style={{
                    padding: '0 22px',
                    background: 'var(--color-ink-900)',
                    color: 'var(--color-ink-50)',
                    border: 'none',
                    borderRadius: 'var(--radius-md)',
                    fontSize: 15,
                    fontWeight: 550,
                    cursor: 'pointer',
                  }}
                >
                  Continue to payment
                </button>
              </form>
            ) : (
              <p style={{ margin: 0, fontSize: 14, color: 'var(--text-muted)' }}>
                Payments are not enabled on this deployment, so this cannot be purchased here yet.
              </p>
            )}
          </Card>

          <p style={{ marginTop: 16, fontSize: 13.5, color: 'var(--text-faint)', maxWidth: 620 }}>
            Everything you have seen so far — your deadlines, the evidence checklist and the
            evidence basis — stays free. The Defence Pack adds the detailed findings and the
            editable document.
          </p>
        </>
      ) : (
        <Card style={{ marginTop: 20 }}>
          <h2 style={{ fontSize: 17, fontWeight: 620, marginBottom: 8 }}>Ready to draft</h2>
          <p style={{ margin: 0, fontSize: 15, color: 'var(--text-muted)' }}>
            Your Defence Pack is active. Drafting uses the verified facts on this case, the grounds
            you are relying on, your own account and the evidence you have attached. Every legal or
            procedural statement in the document traces to an approved reference, and anything that
            cannot be supported is left out and listed separately.
          </p>
          <p style={{ margin: '14px 0 0', fontSize: 14, color: 'var(--text-faint)' }}>
            Document generation requires the AI integration, which is not configured on this
            deployment. Nothing has been charged for a document that cannot be produced.
          </p>
        </Card>
      )}

      <div style={{ marginTop: 28 }}>
        <Disclaimer />
      </div>
    </div>
  );
}
