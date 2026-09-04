import Link from 'next/link';
import { getCase } from '@/server/repositories/cases';
import { buildCaseView } from '@/server/cases/case-view';
import { Card } from '@/components/primitives';
import { CaseUnavailable } from '../CaseUnavailable';

export default async function EvidencePage({ params }: { params: Promise<{ id: string }> }) {
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
  const { evidence } = view;

  return (
    <div className="fr-container" style={{ paddingBlock: 28, maxWidth: 800 }}>
      <nav aria-label="Breadcrumb" style={{ fontSize: 13, marginBottom: 12 }}>
        <Link href={`/case/${id}`} style={{ color: 'var(--text-muted)' }}>
          ← Back to case
        </Link>
      </nav>

      <h1 style={{ fontSize: 'clamp(23px, 3.4vw, 32px)', fontWeight: 630 }}>Evidence</h1>
      <p style={{ marginTop: 10, color: 'var(--text-muted)', fontSize: 16, maxWidth: 620 }}>
        What matters here depends on the contravention and on the grounds you are relying on. This
        list changes as those change.
      </p>

      <div
        style={{
          marginTop: 20,
          display: 'flex',
          gap: 20,
          flexWrap: 'wrap',
          fontSize: 14,
          color: 'var(--text-muted)',
        }}
      >
        <span>
          <strong className="fr-numeric" style={{ color: 'var(--text)' }}>
            {evidence.providedCount}
          </strong>{' '}
          of {evidence.items.length} provided
        </span>
        {evidence.missingEssential.length > 0 && (
          <span style={{ color: 'var(--color-urgent)' }}>
            {evidence.missingEssential.length} essential item
            {evidence.missingEssential.length === 1 ? '' : 's'} missing
          </span>
        )}
      </div>

      <ul style={{ listStyle: 'none', margin: '24px 0 0', padding: 0, display: 'grid', gap: 12 }}>
        {evidence.items.map((item) => (
          <li key={item.type}>
            <Card
              style={{
                borderColor:
                  item.importance === 'ESSENTIAL' && !item.provided
                    ? 'var(--color-urgent)'
                    : 'var(--border)',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 14,
                  alignItems: 'flex-start',
                  flexWrap: 'wrap',
                }}
              >
                <div>
                  <h2 style={{ fontSize: 16, fontWeight: 620 }}>{item.definition.label}</h2>
                  <div
                    className="fr-eyebrow"
                    style={{
                      marginTop: 4,
                      color:
                        item.importance === 'ESSENTIAL'
                          ? 'var(--color-urgent)'
                          : 'var(--text-faint)',
                    }}
                  >
                    {item.importance.toLowerCase()}
                  </div>
                </div>
                <span
                  style={{
                    fontSize: 13,
                    fontWeight: 550,
                    color: item.provided ? 'var(--color-ok)' : 'var(--text-faint)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {item.provided ? `${item.itemCount} uploaded` : 'Not uploaded'}
                </span>
              </div>

              <p style={{ margin: '10px 0 0', fontSize: 14.5 }}>{item.definition.howToCapture}</p>
              <p style={{ margin: '7px 0 0', fontSize: 13.5, color: 'var(--text-muted)' }}>
                {item.definition.whyItMatters}
              </p>
              <p style={{ margin: '7px 0 0', fontSize: 13, color: 'var(--text-faint)' }}>
                Why this case needs it: {item.reason}
              </p>
            </Card>
          </li>
        ))}
      </ul>

      <p style={{ marginTop: 24, fontSize: 13, color: 'var(--text-faint)', maxWidth: 620 }}>
        Everything you upload is stored privately and is readable only by you. You can delete any
        item at any time.
      </p>
    </div>
  );
}
