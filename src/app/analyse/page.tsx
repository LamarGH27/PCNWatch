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
    'Upload your penalty charge notice. PCNWatch reads it, asks you to check what it read, and works out your deadlines from rules rather than guesses.',
  alternates: { canonical: '/analyse' },
  robots: { index: true, follow: true },
};

export default async function AnalysePage() {
  return (
    <div className="fr-container" style={{ paddingBlock: 32, maxWidth: 760 }}>
      <div className="fr-eyebrow" style={{ marginBottom: 8 }}>
        Analyse a notice
      </div>
      <h1 style={{ fontSize: 'clamp(26px, 4vw, 36px)', fontWeight: 630 }}>
        Start with the notice in your hand
      </h1>
      <p style={{ marginTop: 10, color: 'var(--text-muted)', fontSize: 16, maxWidth: 620 }}>
        Photograph the whole notice. We will read it, show you what we read, and ask you to check
        anything important before it counts.
      </p>

      <AnalyseFlow extractionAvailable={isConfigured('anthropic')} />
    </div>
  );
}
