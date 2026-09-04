import type { Metadata } from 'next';
import { COVERAGE_SCOPE } from '@/core/coverage/coverage';
import { getCoverage } from '@/server/repositories/enforcement';
import { CoverageNotice, MeasurementBasis } from '@/components/primitives';
import { MapExplorer } from './MapExplorer';

export const metadata: Metadata = {
  title: 'Enforcement map',
  description:
    'Explore where penalty charge notices have actually been issued in the London Borough of Camden. Search a street, filter by contravention and time, and see the Ticket Activity Score for any location.',
  alternates: { canonical: '/map' },
};

// Coverage depends on ingested data, so this page must not be statically cached
// with a stale answer about what we hold.
export const revalidate = 300;

const PRIMARY_AUTHORITY = COVERAGE_SCOPE.liveAuthoritySlugs[0];

export default async function MapPage() {
  const coverage = await getCoverage(PRIMARY_AUTHORITY);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 'calc(100dvh - 60px)' }}>
      <div
        className="fr-container"
        style={{ paddingBlock: 20, borderBottom: '1px solid var(--border)' }}
      >
        <div
          style={{
            display: 'flex',
            gap: 20,
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
          }}
        >
          <div style={{ minWidth: 260 }}>
            <div className="fr-eyebrow" style={{ marginBottom: 6 }}>
              Enforcement map
            </div>
            <h1 style={{ fontSize: 'clamp(22px, 3vw, 30px)', fontWeight: 620 }}>
              Where PCNs have been issued
            </h1>
            <p
              style={{
                margin: '8px 0 0',
                fontSize: 14.5,
                color: 'var(--text-muted)',
                maxWidth: 560,
              }}
            >
              {COVERAGE_SCOPE.statement} This shows historical enforcement activity. It does not
              tell you whether parking is permitted anywhere.
            </p>
          </div>
          <div style={{ flex: '1 1 320px', maxWidth: 520 }}>
            <CoverageNotice coverage={coverage} />
            <div style={{ marginTop: 12 }}>
              <MeasurementBasis />
            </div>
          </div>
        </div>
      </div>

      <MapExplorer
        authoritySlug={PRIMARY_AUTHORITY}
        canShowActivity={coverage.canShowActivity}
        coverageHeadline={coverage.headline}
        coverageDetail={coverage.detail}
      />
    </div>
  );
}
