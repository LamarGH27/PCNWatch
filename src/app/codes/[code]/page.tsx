import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getContravention, isPubliclyIndexable, referencesByCategory } from '@/core/reference/store';
import { EVIDENCE_DEFINITIONS } from '@/core/evidence/definitions';
import type { EvidenceType } from '@/core/evidence/types';
import { Card, Disclaimer } from '@/components/primitives';

interface PageProps {
  params: Promise<{ code: string }>;
}

/** Only codes we actually hold a record for get a page. Nothing is generated for SEO. */
export function generateStaticParams() {
  return referencesByCategory('CONTRAVENTION').map((record) => ({
    code: String((record.content as { code?: string }).code ?? ''),
  }));
}

export const dynamicParams = false;

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { code } = await params;
  const record = getContravention(code);
  if (!record) return { title: 'Contravention code', robots: { index: false, follow: false } };

  const title = `Contravention code ${code} — what it means`;
  return {
    title,
    description: record.summary,
    alternates: { canonical: `/codes/${code}` },
    openGraph: { title, description: record.summary, url: `/codes/${code}` },
    // Content awaiting legal review is useful to someone holding that notice, but
    // publishing it for search traffic would be asserting unverified legal content.
    robots: isPubliclyIndexable(record)
      ? { index: true, follow: true }
      : { index: false, follow: true },
  };
}

interface ContraventionContent {
  code: string;
  officialDescription: string;
  plainEnglish: string;
  enforcementType: string;
  penaltyBand: string;
  commonFactualQuestions?: string[];
  relevantEvidence?: EvidenceType[];
}

export default async function CodePage({ params }: PageProps) {
  const { code } = await params;
  const record = getContravention(code);
  if (!record) notFound();

  const content = record.content as unknown as ContraventionContent;

  return (
    <div className="fr-container" style={{ paddingBlock: 36, maxWidth: 820 }}>
      <nav aria-label="Breadcrumb" style={{ fontSize: 13, marginBottom: 14 }}>
        <Link href="/codes" style={{ color: 'var(--text-muted)' }}>
          Contravention codes
        </Link>
        <span style={{ color: 'var(--text-faint)' }}> / {content.code}</span>
      </nav>

      <div className="fr-eyebrow" style={{ marginBottom: 8 }}>
        {content.enforcementType.replace('_', ' ')} contravention
      </div>
      <h1 style={{ fontSize: 'clamp(26px, 4vw, 38px)', fontWeight: 630 }}>
        Contravention code {content.code}
      </h1>

      <section style={{ marginTop: 26 }}>
        <h2 style={{ fontSize: 13, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-faint)', marginBottom: 8 }}>
          Official description
        </h2>
        <blockquote
          style={{
            margin: 0,
            padding: '14px 18px',
            background: 'var(--surface-sunken)',
            borderLeft: '3px solid var(--border-strong)',
            borderRadius: '0 var(--radius-md) var(--radius-md) 0',
            fontSize: 16,
          }}
        >
          {content.officialDescription}
        </blockquote>
      </section>

      <section style={{ marginTop: 30 }}>
        <h2 style={{ fontSize: 20, fontWeight: 620, marginBottom: 10 }}>What this means</h2>
        <p style={{ margin: 0, fontSize: 16, color: 'var(--text-muted)' }}>{content.plainEnglish}</p>
      </section>

      <section style={{ marginTop: 30 }}>
        <h2 style={{ fontSize: 20, fontWeight: 620, marginBottom: 10 }}>Penalty level</h2>
        <p style={{ margin: 0, fontSize: 15.5, color: 'var(--text-muted)' }}>
          {content.penaltyBand === 'UNKNOWN'
            ? 'We do not hold a verified penalty band for this code, so we will not state an amount. The amount payable is shown on your notice.'
            : `This code is normally charged at the ${content.penaltyBand.toLowerCase()} band. Bands differ between authorities, so the amount on your notice is authoritative.`}
        </p>
      </section>

      {content.commonFactualQuestions && content.commonFactualQuestions.length > 0 && (
        <section style={{ marginTop: 30 }}>
          <h2 style={{ fontSize: 20, fontWeight: 620, marginBottom: 12 }}>
            Questions this usually turns on
          </h2>
          <Card>
            <ul style={{ margin: 0, paddingLeft: 20, display: 'grid', gap: 9, fontSize: 15 }}>
              {content.commonFactualQuestions.map((question) => (
                <li key={question} style={{ color: 'var(--text-muted)' }}>
                  {question}
                </li>
              ))}
            </ul>
          </Card>
        </section>
      )}

      {content.relevantEvidence && content.relevantEvidence.length > 0 && (
        <section style={{ marginTop: 30 }}>
          <h2 style={{ fontSize: 20, fontWeight: 620, marginBottom: 12 }}>
            Evidence commonly relevant
          </h2>
          <div style={{ display: 'grid', gap: 10 }}>
            {content.relevantEvidence.map((type) => {
              const definition = EVIDENCE_DEFINITIONS[type];
              if (!definition) return null;
              return (
                <Card key={type}>
                  <h3 style={{ fontSize: 15.5, fontWeight: 600, marginBottom: 5 }}>
                    {definition.label}
                  </h3>
                  <p style={{ margin: '0 0 6px', fontSize: 14, color: 'var(--text-muted)' }}>
                    {definition.howToCapture}
                  </p>
                  <p style={{ margin: 0, fontSize: 13, color: 'var(--text-faint)' }}>
                    {definition.whyItMatters}
                  </p>
                </Card>
              );
            })}
          </div>
        </section>
      )}

      <section style={{ marginTop: 30 }}>
        <h2 style={{ fontSize: 20, fontWeight: 620, marginBottom: 10 }}>Procedure</h2>
        <p style={{ margin: 0, fontSize: 15.5, color: 'var(--text-muted)' }}>
          A local-authority PCN follows the statutory process: a reduced amount is normally payable
          within the discount period, you may challenge the notice, and if a Notice to Owner is
          served you may make formal representations on specific statutory grounds. If those are
          rejected you may appeal to an independent adjudicator.
        </p>
        <p style={{ marginTop: 10 }}>
          <Link href="/analyse">Upload your notice to see which stage you are at →</Link>
        </p>
      </section>

      <section style={{ marginTop: 30, paddingTop: 22, borderTop: '1px solid var(--border)' }}>
        <div className="fr-eyebrow" style={{ marginBottom: 8 }}>
          Source
        </div>
        <p style={{ margin: 0, fontSize: 13.5, color: 'var(--text-muted)' }}>
          {record.sourceName} ·{' '}
          <a href={record.sourceLocation} rel="noopener noreferrer" target="_blank">
            {record.sourceLocation}
          </a>
        </p>
        <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--text-faint)' }}>
          {record.reviewedAt
            ? `Last reviewed ${record.reviewedAt}.`
            : 'This record has not yet been reviewed by a qualified person. Always check the wording printed on your own notice.'}
        </p>
        <div style={{ marginTop: 16 }}>
          <Disclaimer />
        </div>
      </section>
    </div>
  );
}
