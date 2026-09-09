import type { Metadata } from 'next';
import Link from 'next/link';
import { LONDON_AUTHORITIES } from '@/server/repositories/authorities-data';
import { COVERAGE_SCOPE } from '@/core/coverage/coverage';
import { GlassCard, Pill } from '@/components/marketing';

export const metadata: Metadata = {
  title: 'London boroughs',
  description:
    'London local authorities that issue penalty charge notices, with challenge and payment information and PCNWatch enforcement map coverage for each.',
  alternates: { canonical: '/boroughs' },
};

/*
 * Three states, said in three different ways.
 *
 * The distinction is the point of the page: "live" means a published dataset
 * has been ingested and the map will show something, "coming soon" means it has
 * been identified and has not, and "planned" means neither. Collapsing them
 * into one green tick would be the exact overclaim this section exists to
 * avoid.
 */
const COVERAGE_LABEL = {
  LIVE: { label: 'Live now', accent: 'cyan' as const },
  PLANNED: { label: 'Coming soon', accent: 'brand' as const },
  UNAVAILABLE: { label: 'Planned', accent: 'muted' as const },
} as const;

export default function BoroughsPage() {
  return (
    <div className="fr-container fr-stack" style={{ paddingBlock: 'clamp(36px, 6vw, 64px)' }}>
      <div className="fr-eyebrow">Directory</div>
      <h1
        style={{
          marginTop: 12,
          fontSize: 'clamp(30px, 4.8vw, 46px)',
          fontWeight: 700,
          letterSpacing: '-0.03em',
          lineHeight: 1.06,
        }}
      >
        From Camden to every borough and beyond.
      </h1>
      <p className="fr-lede" style={{ marginTop: 16 }}>
        Scanning a notice, explaining the contravention and building a challenge work for notices
        from any of these authorities. Enforcement map coverage is separate and much narrower.{' '}
        {COVERAGE_SCOPE.statement}
      </p>

      {/* A legend, because three pills mean nothing without one. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 22 }}>
        <Pill accent="cyan">Live now — data ingested</Pill>
        <Pill accent="brand">Coming soon — identified, not yet live</Pill>
        <Pill accent="muted">Planned — no dataset yet</Pill>
      </div>

      <ul
        style={{
          listStyle: 'none',
          margin: '32px 0 0',
          padding: 0,
          display: 'grid',
          gap: 16,
          gridTemplateColumns: 'repeat(auto-fill, minmax(min(300px, 100%), 1fr))',
        }}
      >
        {LONDON_AUTHORITIES.map((authority) => {
          const coverage = COVERAGE_LABEL[authority.mapCoverage];
          return (
            <li key={authority.slug}>
              <GlassCard interactive>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start' }}>
                  <h2 style={{ fontSize: 16.5, fontWeight: 640, letterSpacing: '-0.01em' }}>
                    {authority.name}
                  </h2>
                  <span style={{ flexShrink: 0 }}>
                    <Pill accent={coverage.accent}>{coverage.label}</Pill>
                  </span>
                </div>

                <ul style={{ listStyle: 'none', margin: '14px 0 0', padding: 0, fontSize: 13.5, display: 'grid', gap: 6 }}>
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
              </GlassCard>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
