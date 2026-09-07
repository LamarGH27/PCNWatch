import Link from 'next/link';
import { getCase } from '@/server/repositories/cases';
import { buildCaseView } from '@/server/cases/case-view';
import { Card } from '@/components/primitives';
import { COMPARISON_CAUTION } from '@/core/evidence/compare';
import { CaseUnavailable } from '../CaseUnavailable';
import { EvidencePanel } from './EvidencePanel';

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
  const { evidence, evidenceItems, evidenceComparisons } = view;
  const compared = evidenceComparisons.filter((c) => c.outcome !== 'NOT_COMPARED');
  const differing = compared.filter((c) => c.outcome === 'DIFFERS');

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
          of {evidence.items.length} checked
        </span>
        {evidence.awaitingCheckCount > 0 && (
          <span>
            {evidence.awaitingCheckCount} uploaded and waiting for you to check
          </span>
        )}
        {evidence.missingEssential.length > 0 && (
          <span style={{ color: 'var(--color-urgent)' }}>
            {evidence.missingEssential.length} essential item
            {evidence.missingEssential.length === 1 ? '' : 's'} missing
          </span>
        )}
      </div>

      <EvidencePanel caseId={id} items={evidence.items} evidence={evidenceItems} />

      {compared.length > 0 && (
        <Card style={{ marginTop: 24 }}>
          <h2 style={{ fontSize: 16, fontWeight: 620 }}>
            What your documents say, beside what your notice says
          </h2>
          <ul style={{ listStyle: 'none', margin: '10px 0 0', padding: 0, display: 'grid', gap: 8 }}>
            {/*
              Differences first, and never omitted. A list of matches with a
              contradiction left off the bottom would be the most flattering
              and most dangerous thing this page could show.
            */}
            {[...differing, ...compared.filter((c) => c.outcome === 'CONSISTENT')].map(
              (comparison, index) => (
                <li
                  key={`${comparison.evidenceId}-${comparison.field}-${index}`}
                  style={{
                    fontSize: 14,
                    color:
                      comparison.outcome === 'DIFFERS' ? 'var(--color-urgent)' : 'var(--text)',
                  }}
                >
                  {comparison.statement}
                </li>
              ),
            )}
          </ul>
          <p style={{ margin: '12px 0 0', fontSize: 13, color: 'var(--text-muted)' }}>
            {COMPARISON_CAUTION}
          </p>
        </Card>
      )}

      <p style={{ marginTop: 24, fontSize: 13, color: 'var(--text-faint)', maxWidth: 620 }}>
        Everything you upload is stored privately and is readable only by you. You can delete any
        item at any time. A file we hold is not the same as evidence supporting your case: nothing
        counts until you have checked what we read off it.
      </p>
    </div>
  );
}
