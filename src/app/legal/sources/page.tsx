import type { Metadata } from 'next';
import Link from 'next/link';
import { CAMDEN_SOURCE } from '@/data-sources/camden/adapter';
import { allReferences } from '@/core/reference/store';
import { COVERAGE_SCOPE } from '@/core/coverage/coverage';
import { Card } from '@/components/primitives';

export const metadata: Metadata = {
  title: 'Data sources',
  description:
    'The datasets and reference material PCNWatch relies on, with licences, attribution and review status.',
  alternates: { canonical: '/legal/sources' },
};

export default function SourcesPage() {
  const references = allReferences();
  const reviewed = references.filter((r) => r.reviewStatus === 'REVIEWED').length;

  return (
    <div className="fr-container" style={{ paddingBlock: 40, maxWidth: 800 }}>
      <h1 style={{ fontSize: 'clamp(26px, 4vw, 36px)', fontWeight: 630 }}>Data sources</h1>
      <p style={{ marginTop: 12, fontSize: 16, color: 'var(--text-muted)', maxWidth: 640 }}>
        Every figure and every legal statement in PCNWatch traces to something on this page.
      </p>

      <section style={{ marginTop: 34 }}>
        <h2 style={{ fontSize: 20, fontWeight: 620, marginBottom: 14 }}>Enforcement data</h2>
        <Card>
          <h3 style={{ fontSize: 16, fontWeight: 620, marginBottom: 6 }}>{CAMDEN_SOURCE.name}</h3>
          <dl style={{ margin: 0, display: 'grid', gap: 8, fontSize: 14.5 }}>
            <Row label="Publisher" value={CAMDEN_SOURCE.publisher} />
            <Row
              label="Licence"
              value={
                CAMDEN_SOURCE.licenceUrl ? (
                  <a href={CAMDEN_SOURCE.licenceUrl} rel="noopener noreferrer" target="_blank">
                    {CAMDEN_SOURCE.licence}
                  </a>
                ) : (
                  CAMDEN_SOURCE.licence ?? 'Not stated'
                )
              }
            />
            <Row
              label="Source"
              value={
                CAMDEN_SOURCE.sourceUrl ? (
                  <a href={CAMDEN_SOURCE.sourceUrl} rel="noopener noreferrer" target="_blank">
                    {CAMDEN_SOURCE.sourceUrl}
                  </a>
                ) : (
                  'Not stated'
                )
              }
            />
            <Row label="Coverage" value={CAMDEN_SOURCE.coverageNotes} />
          </dl>
          <p style={{ margin: '14px 0 0', fontSize: 13, color: 'var(--text-faint)' }}>
            {CAMDEN_SOURCE.attributionText}
          </p>
        </Card>
        <p style={{ marginTop: 14, fontSize: 14, color: 'var(--text-muted)' }}>
          {COVERAGE_SCOPE.statement} Every ingestion run records how many rows were fetched,
          accepted, rejected and geolocated, and why each rejected row was rejected.
        </p>
      </section>

      <section style={{ marginTop: 34 }}>
        <h2 style={{ fontSize: 20, fontWeight: 620, marginBottom: 8 }}>Reference material</h2>
        <p style={{ margin: '0 0 14px', fontSize: 14.5, color: 'var(--text-muted)', maxWidth: 640 }}>
          PCNWatch holds {references.length} approved reference records, of which {reviewed}{' '}
          {reviewed === 1 ? 'has' : 'have'} been reviewed by a qualified person. A record awaiting
          review is still shown to you — it may be exactly what you need — but it is marked as such
          and is not published for search engines. Generative output may only cite a record that
          exists here.
        </p>

        <div className="fr-scroll-x">
          <table style={{ width: '100%', minWidth: 680, borderCollapse: 'collapse', fontSize: 13.5 }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border-strong)' }}>
                {['Reference', 'Category', 'Source', 'Review status'].map((h) => (
                  <th key={h} style={{ padding: '9px 12px 9px 0', fontWeight: 600, fontSize: 12 }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {references.map((record) => (
                <tr key={record.key} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '10px 12px 10px 0' }}>{record.title}</td>
                  <td style={{ padding: '10px 12px 10px 0', color: 'var(--text-faint)' }}>
                    {record.category.replace(/_/g, ' ').toLowerCase()}
                  </td>
                  <td style={{ padding: '10px 12px 10px 0' }}>
                    <a href={record.sourceLocation} rel="noopener noreferrer" target="_blank">
                      {record.sourceName}
                    </a>
                  </td>
                  <td style={{ padding: '10px 0' }}>
                    {record.reviewStatus === 'REVIEWED' ? (
                      <span style={{ color: 'var(--color-ok)' }}>Reviewed {record.reviewedAt}</span>
                    ) : (
                      <span style={{ color: 'var(--color-warn)' }}>Awaiting review</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <p style={{ marginTop: 30, fontSize: 14 }}>
        <Link href="/legal/scope">What PCNWatch does and does not do →</Link>
      </p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: 12 }}>
      <dt style={{ color: 'var(--text-faint)', fontSize: 13 }}>{label}</dt>
      <dd style={{ margin: 0 }}>{value}</dd>
    </div>
  );
}
