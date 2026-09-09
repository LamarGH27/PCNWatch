import type { Metadata } from 'next';
import { isConfigured } from '@/lib/env';
import { AnalyseFlow } from './AnalyseFlow';

/**
 * Rendered per request: this page now asks the database whether storage is
 * safe to use. Prerendered, that answer would be frozen at build time — a build
 * run before the storage policies exist would bake "uploads unavailable" into
 * the page, and one run against a database that was briefly unreachable would
 * do the same.
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Analyse your PCN',
  description:
    'Upload your penalty charge notice. PCNWatch reads it, asks you to check what it read, and explains what the contravention actually alleges.',
  alternates: { canonical: '/analyse' },
  robots: { index: true, follow: true },
};

export default async function AnalysePage() {
  return (
    <div className="fr-container" style={{ paddingBlock: 'clamp(32px, 5vw, 52px)', maxWidth: 780 }}>
      <div className="fr-eyebrow">Analyse a notice</div>
      <h1
        style={{
          marginTop: 12,
          fontSize: 'clamp(30px, 4.6vw, 44px)',
          fontWeight: 700,
          letterSpacing: '-0.03em',
          lineHeight: 1.08,
        }}
      >
        Start with the notice in your hand
      </h1>
      <p className="fr-lede" style={{ marginTop: 14 }}>
        Photograph the whole notice. We will read it, show you what we read, and ask you to check
        anything important before it counts.
      </p>

      {/* Three lines about what happens next, so the upload box is not the
          first thing somebody meets with no idea how long this will take. */}
      <ul
        style={{
          listStyle: 'none',
          display: 'flex',
          flexWrap: 'wrap',
          gap: '10px 22px',
          margin: '20px 0 0',
          padding: 0,
          fontSize: 13.5,
          color: 'var(--text-muted)',
        }}
      >
        {['Around two minutes', 'At most three follow-up questions', 'Nothing counts until you confirm it'].map(
          (line) => (
            <li key={line} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <span aria-hidden="true" style={{ color: 'var(--color-cyan-400)' }}>
                ●
              </span>
              {line}
            </li>
          ),
        )}
      </ul>

      <AnalyseFlow extractionAvailable={isConfigured('anthropic')} />
    </div>
  );
}
