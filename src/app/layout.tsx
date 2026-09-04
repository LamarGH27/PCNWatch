import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import { publicEnv } from '@/lib/env';
import { COVERAGE_SCOPE } from '@/core/coverage/coverage';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL(publicEnv.NEXT_PUBLIC_SITE_URL),
  title: {
    default: 'FineRadar — see where tickets happen',
    template: '%s · FineRadar',
  },
  description:
    'Explore where parking and traffic penalties are actually being issued in London. Already received a PCN? Decode it, organise your evidence and build your challenge.',
  applicationName: 'FineRadar',
  openGraph: {
    type: 'website',
    siteName: 'FineRadar',
    locale: 'en_GB',
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fbfbf9' },
    { media: '(prefers-color-scheme: dark)', color: '#0b0d0f' },
  ],
};

const NAV = [
  { href: '/map', label: 'Map' },
  { href: '/hotspots', label: 'Hotspots' },
  { href: '/codes', label: 'Codes' },
  { href: '/boroughs', label: 'Boroughs' },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-GB">
      <body>
        <a className="fr-skip-link" href="#main">
          Skip to content
        </a>

        <header
          style={{
            borderBottom: '1px solid var(--border)',
            background: 'var(--surface)',
            position: 'sticky',
            top: 0,
            zIndex: 40,
          }}
        >
          <div
            className="fr-container"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 16,
              height: 60,
            }}
          >
            <Link
              href="/"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 9,
                textDecoration: 'none',
                color: 'var(--text)',
              }}
            >
              <RadarMark />
              <span style={{ fontWeight: 650, fontSize: 17, letterSpacing: '-0.02em' }}>
                FineRadar
              </span>
            </Link>

            <nav aria-label="Primary" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              {NAV.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="fr-touch"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    padding: '0 11px',
                    fontSize: 14,
                    color: 'var(--text-muted)',
                    textDecoration: 'none',
                    borderRadius: 'var(--radius-sm)',
                  }}
                >
                  {item.label}
                </Link>
              ))}
              <Link
                href="/analyse"
                className="fr-touch"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  marginLeft: 6,
                  padding: '0 14px',
                  fontSize: 14,
                  fontWeight: 550,
                  background: 'var(--color-ink-900)',
                  color: 'var(--color-ink-50)',
                  borderRadius: 'var(--radius-md)',
                  textDecoration: 'none',
                }}
              >
                Analyse my PCN
              </Link>
            </nav>
          </div>
        </header>

        <main id="main">{children}</main>

        <footer
          style={{
            borderTop: '1px solid var(--border)',
            marginTop: 72,
            paddingBlock: '40px 56px',
            background: 'var(--surface-sunken)',
          }}
        >
          <div className="fr-container">
            <div
              style={{
                display: 'grid',
                gap: 28,
                gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
              }}
            >
              <div>
                <div className="fr-eyebrow" style={{ marginBottom: 10 }}>
                  Coverage
                </div>
                <p style={{ margin: 0, fontSize: 13, color: 'var(--text-muted)', maxWidth: 320 }}>
                  {COVERAGE_SCOPE.statement} {COVERAGE_SCOPE.explanation}
                </p>
              </div>
              <div>
                <div className="fr-eyebrow" style={{ marginBottom: 10 }}>
                  Explore
                </div>
                <ul style={{ listStyle: 'none', margin: 0, padding: 0, fontSize: 13 }}>
                  {NAV.map((item) => (
                    <li key={item.href} style={{ marginBottom: 7 }}>
                      <Link href={item.href} style={{ color: 'var(--text-muted)' }}>
                        {item.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <div className="fr-eyebrow" style={{ marginBottom: 10 }}>
                  Legal
                </div>
                <ul style={{ listStyle: 'none', margin: 0, padding: 0, fontSize: 13 }}>
                  <li style={{ marginBottom: 7 }}>
                    <Link href="/legal/privacy" style={{ color: 'var(--text-muted)' }}>
                      Privacy
                    </Link>
                  </li>
                  <li style={{ marginBottom: 7 }}>
                    <Link href="/legal/scope" style={{ color: 'var(--text-muted)' }}>
                      What FineRadar does and does not do
                    </Link>
                  </li>
                  <li style={{ marginBottom: 7 }}>
                    <Link href="/legal/sources" style={{ color: 'var(--text-muted)' }}>
                      Data sources
                    </Link>
                  </li>
                </ul>
              </div>
            </div>

            <p
              style={{
                marginTop: 32,
                paddingTop: 20,
                borderTop: '1px solid var(--border)',
                fontSize: 12.5,
                color: 'var(--text-faint)',
                maxWidth: 720,
              }}
            >
              FineRadar provides information and document-preparation tools. It does not provide
              legal advice and does not guarantee that a challenge will succeed. Enforcement
              activity shows where penalties have historically been issued; it does not tell you
              whether parking is permitted at any location.
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}

function RadarMark() {
  return (
    <svg width="21" height="21" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="10" stroke="var(--color-ink-400)" strokeWidth="1.2" />
      <circle cx="12" cy="12" r="5.5" stroke="var(--color-ink-400)" strokeWidth="1.2" />
      <path d="M12 12 L20 7" stroke="var(--color-signal-500)" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="12" cy="12" r="1.9" fill="var(--color-signal-500)" />
    </svg>
  );
}
