import Link from 'next/link';
import { getCase } from '@/server/repositories/cases';
import { buildCaseView } from '@/server/cases/case-view';
import { EVIDENCE_BASIS_LABELS, type FindingCategory } from '@/core/assessment/types';
import { EVIDENCE_DEFINITIONS } from '@/core/evidence/definitions';
import { Card, Disclaimer } from '@/components/primitives';
import { CaseUnavailable } from '../CaseUnavailable';

const CATEGORY_TITLES: Record<FindingCategory, { title: string; blurb: string }> = {
  STATUTORY_GROUND: {
    title: 'Statutory grounds',
    blurb: 'Grounds set out in legislation that you may rely on at this stage.',
  },
  FACTUAL_DISPUTE: {
    title: 'Factual disputes',
    blurb: 'Questions about what actually happened, which evidence answers.',
  },
  PROCEDURAL_ISSUE: {
    title: 'Procedural issues',
    blurb: 'Points about how the authority has handled the notice.',
  },
  DISCRETIONARY: {
    title: 'Mitigating circumstances',
    blurb:
      'Reasons an authority might cancel the notice at its discretion. These are not statutory grounds and are not guaranteed to succeed.',
  },
};

export default async function AssessmentPage({ params }: { params: Promise<{ id: string }> }) {
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
  const { assessment } = view;

  return (
    <div className="fr-container" style={{ paddingBlock: 28, maxWidth: 820 }}>
      <nav aria-label="Breadcrumb" style={{ fontSize: 13, marginBottom: 12 }}>
        <Link href={`/case/${id}`} style={{ color: 'var(--text-muted)' }}>
          ← Back to case
        </Link>
      </nav>

      <h1 style={{ fontSize: 'clamp(23px, 3.4vw, 32px)', fontWeight: 630 }}>Assessment</h1>

      <Card style={{ marginTop: 20 }}>
        <div className="fr-eyebrow" style={{ marginBottom: 6 }}>
          Evidence basis
        </div>
        <div style={{ fontSize: 22, fontWeight: 630, marginBottom: 8 }}>
          {EVIDENCE_BASIS_LABELS[assessment.basis]}
        </div>
        <p style={{ margin: 0, fontSize: 15, color: 'var(--text-muted)' }}>
          {assessment.basisExplanation}
        </p>
      </Card>

      {assessment.missingInformation.length > 0 && (
        <section style={{ marginTop: 28 }}>
          <h2 style={{ fontSize: 18, fontWeight: 620, marginBottom: 10 }}>
            What we still do not know
          </h2>
          <Card>
            <ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 7, fontSize: 14.5 }}>
              {assessment.missingInformation.map((item) => (
                <li key={item} style={{ color: 'var(--text-muted)' }}>
                  {item}
                </li>
              ))}
            </ul>
          </Card>
        </section>
      )}

      {(Object.keys(CATEGORY_TITLES) as FindingCategory[]).map((category) => {
        const findings = assessment.findingsByCategory[category];
        if (findings.length === 0) return null;
        const meta = CATEGORY_TITLES[category];

        return (
          <section key={category} style={{ marginTop: 32 }}>
            <h2 style={{ fontSize: 18, fontWeight: 620, marginBottom: 4 }}>{meta.title}</h2>
            <p style={{ margin: '0 0 14px', fontSize: 13.5, color: 'var(--text-faint)' }}>
              {meta.blurb}
            </p>

            <div style={{ display: 'grid', gap: 12 }}>
              {findings.map((finding) => (
                <Card key={finding.id}>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      gap: 12,
                      alignItems: 'flex-start',
                      flexWrap: 'wrap',
                    }}
                  >
                    <h3 style={{ fontSize: 16, fontWeight: 620, maxWidth: 560 }}>{finding.issue}</h3>
                    <span
                      className="fr-eyebrow"
                      style={{
                        color:
                          finding.confidence === 'HIGH'
                            ? 'var(--color-ok)'
                            : finding.confidence === 'MEDIUM'
                              ? 'var(--color-warn)'
                              : 'var(--text-faint)',
                      }}
                    >
                      {finding.confidence} confidence
                    </span>
                  </div>

                  <p style={{ margin: '10px 0 0', fontSize: 14.5, color: 'var(--text-muted)' }}>
                    {finding.whyItMayMatter}
                  </p>

                  {finding.evidenceNeeded.length > 0 && (
                    <dl
                      style={{
                        margin: '14px 0 0',
                        display: 'grid',
                        gap: 10,
                        gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                        fontSize: 13.5,
                      }}
                    >
                      <div>
                        <dt className="fr-eyebrow" style={{ marginBottom: 4 }}>
                          Evidence needed
                        </dt>
                        <dd style={{ margin: 0, color: 'var(--text-muted)' }}>
                          {finding.evidenceNeeded
                            .map((t) => EVIDENCE_DEFINITIONS[t]?.label ?? t)
                            .join(', ')}
                        </dd>
                      </div>
                      <div>
                        <dt className="fr-eyebrow" style={{ marginBottom: 4 }}>
                          Evidence you have
                        </dt>
                        <dd
                          style={{
                            margin: 0,
                            color:
                              finding.evidenceAvailable.length === 0
                                ? 'var(--color-urgent)'
                                : 'var(--text-muted)',
                          }}
                        >
                          {finding.evidenceAvailable.length === 0
                            ? 'None yet'
                            : finding.evidenceAvailable
                                .map((t) => EVIDENCE_DEFINITIONS[t]?.label ?? t)
                                .join(', ')}
                        </dd>
                      </div>
                    </dl>
                  )}

                  {finding.citations.length > 0 && (
                    <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
                      <div className="fr-eyebrow" style={{ marginBottom: 5 }}>
                        Source
                      </div>
                      {finding.citations.map((citation) => (
                        <p
                          key={`${citation.key}@${citation.version}`}
                          style={{ margin: 0, fontSize: 12.5, color: 'var(--text-faint)' }}
                        >
                          {citation.sourceName} ·{' '}
                          <a href={citation.sourceLocation} rel="noopener noreferrer" target="_blank">
                            open
                          </a>
                          {citation.reviewStatus !== 'REVIEWED' && ' · awaiting review'}
                        </p>
                      ))}
                    </div>
                  )}
                </Card>
              ))}
            </div>
          </section>
        );
      })}

      <div style={{ marginTop: 32 }}>
        <Disclaimer>
          This assessment describes how well your case is evidenced against the grounds you are
          relying on. It is not a prediction of the outcome. PCNWatch provides information and
          document-preparation tools. It does not provide legal advice and does not guarantee that a
          challenge will succeed.
        </Disclaimer>
      </div>
    </div>
  );
}
