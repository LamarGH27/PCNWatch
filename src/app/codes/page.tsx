import type { Metadata } from 'next';
import Link from 'next/link';
import { referencesByCategory } from '@/core/reference/store';
import { Card } from '@/components/primitives';

export const metadata: Metadata = {
  title: 'Contravention codes',
  description:
    'Plain-English explanations of the parking contravention codes used by London enforcement authorities, with the questions each one turns on and the evidence commonly relevant.',
  alternates: { canonical: '/codes' },
};

export default function CodesIndexPage() {
  const codes = [...referencesByCategory('CONTRAVENTION')].sort((a, b) =>
    String((a.content as { code?: string }).code ?? '').localeCompare(
      String((b.content as { code?: string }).code ?? ''),
    ),
  );

  return (
    <div className="fr-container" style={{ paddingBlock: 40 }}>
      <div className="fr-eyebrow" style={{ marginBottom: 8 }}>
        Reference
      </div>
      <h1 style={{ fontSize: 'clamp(26px, 4vw, 38px)', fontWeight: 630 }}>Contravention codes</h1>
      <p style={{ marginTop: 12, maxWidth: 660, color: 'var(--text-muted)', fontSize: 16 }}>
        The code on your penalty charge notice tells you what the authority says you did. We hold a
        record for each of the codes below. If your code is not listed, we do not hold a record for
        it, and we would rather tell you that than describe it from memory.
      </p>

      <ul
        style={{
          listStyle: 'none',
          margin: '32px 0 0',
          padding: 0,
          display: 'grid',
          gap: 12,
          gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
        }}
      >
        {codes.map((record) => {
          const content = record.content as { code?: string; enforcementType?: string };
          return (
            <li key={record.key}>
              <Card>
                <Link
                  href={`/codes/${content.code}`}
                  style={{ textDecoration: 'none', color: 'var(--text)' }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'baseline',
                      justifyContent: 'space-between',
                      gap: 10,
                      marginBottom: 7,
                    }}
                  >
                    <span className="fr-numeric" style={{ fontSize: 20, fontWeight: 650 }}>
                      {content.code}
                    </span>
                    <span className="fr-eyebrow">{content.enforcementType?.replace('_', ' ')}</span>
                  </div>
                  <p style={{ margin: 0, fontSize: 14, color: 'var(--text-muted)' }}>
                    {record.summary}
                  </p>
                </Link>
              </Card>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
