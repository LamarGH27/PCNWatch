import type { Metadata } from 'next';
import Link from 'next/link';
import { LONDON_AUTHORITIES } from '@/server/repositories/authorities-data';
import { COVERAGE_SCOPE } from '@/core/coverage/coverage';
import { Card } from '@/components/primitives';

export const metadata: Metadata = {
  title: 'London boroughs',
  description:
    'London local authorities that issue penalty charge notices, with challenge and payment information and FineRadar enforcement map coverage for each.',
  alternates: { canonical: '/boroughs' },
};

const COVERAGE_LABEL = {
  LIVE: { label: 'Map data available', colour: 'var(--color-ok)' },
  PLANNED: { label: 'Planned', colour: 'var(--color-warn)' },
  UNAVAILABLE: { label: 'No map data', colour: 'var(--text-faint)' },
} as const;

export default function BoroughsPage() {
  return (
    <div className="fr-container" style={{ paddingBlock: 40 }}>
      <div className="fr-eyebrow" style={{ marginBottom: 8 }}>
        Directory
      </div>
      <h1 style={{ fontSize: 'clamp(26px, 4vw, 38px)', fontWeight: 630 }}>London boroughs</h1>
      <p style={{ marginTop: 12, maxWidth: 680, color: 'var(--text-muted)', fontSize: 16 }}>
        PCN analysis, deadline tracking and challenge drafting work for notices from any of these
        authorities. Enforcement map coverage is separate and much narrower: {COVERAGE_SCOPE.statement.toLowerCase()}
      </p>

      <ul
        style={{
          listStyle: 'none',
          margin: '32px 0 0',
          padding: 0,
          display: 'grid',
          gap: 12,
          gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
        }}
      >
        {LONDON_AUTHORITIES.map((authority) => {
          const coverage = COVERAGE_LABEL[authority.mapCoverage];
          return (
            <li key={authority.slug}>
              <Card>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start' }}>
                  <h2 style={{ fontSize: 16, fontWeight: 620 }}>{authority.name}</h2>
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      color: coverage.colour,
                      whiteSpace: 'nowrap',
                      paddingTop: 2,
                    }}
                  >
                    {coverage.label}
                  </span>
                </div>

                <ul style={{ listStyle: 'none', margin: '12px 0 0', padding: 0, fontSize: 13.5, display: 'grid', gap: 5 }}>
                  <li>
                    <a href={authority.websiteUrl} rel="noopener noreferrer" target="_blank">
                      Council website
                    </a>
                  </li>
                  {authority.challengeInfoUrl && (
                    <li>
                      <a href={authority.challengeInfoUrl} rel="noopener noreferrer" target="_blank">
                        How to challenge a PCN
                      </a>
                    </li>
                  )}
                  {authority.paymentInfoUrl && (
                    <li>
                      <a href={authority.paymentInfoUrl} rel="noopener noreferrer" target="_blank">
                        Pay a PCN
                      </a>
                    </li>
                  )}
                  {authority.mapCoverage === 'LIVE' && (
                    <li>
                      <Link href={`/hotspots?authority=${authority.slug}`}>Enforcement hotspots</Link>
                    </li>
                  )}
                </ul>

                <p style={{ margin: '12px 0 0', fontSize: 12.5, color: 'var(--text-faint)' }}>
                  Appeals: {authority.tribunalRoute}.{' '}
                  {authority.reviewedAt
                    ? `Links last checked ${authority.reviewedAt}.`
                    : 'Links have not been recently verified — check the council site if one does not work.'}
                </p>
              </Card>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
