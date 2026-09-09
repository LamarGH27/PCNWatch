import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import { publicEnv } from '@/lib/env';
import { COVERAGE_SCOPE } from '@/core/coverage/coverage';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL(publicEnv.NEXT_PUBLIC_SITE_URL),
  title: {
    default: 'PCNWatch — fight unfair parking tickets with clarity',
    template: '%s · PCNWatch',
  },
  description:
    'Scan your penalty charge notice, understand what it means in plain English, and build a stronger response with clear guidance and an evidence checklist.',
  applicationName: 'PCNWatch',
  openGraph: {
    type: 'website',
    siteName: 'PCNWatch',
    locale: 'en_GB',
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  // One colour, because the site is dark whichever way the system is set.
  themeColor: '#05070d',
};

/**
 * The public pages, for the header strip and the footer's Explore column.
 *
 * "Your cases" is deliberately not in here. It is one person's private, noindex
 * list rather than something to explore, and the footer column is about what
 * the site holds — so it appears in the header only, where somebody looking for
 * their own case will actually be.
 */
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

        <header className="fr-header">
          <div className="fr-container fr-header-inner">
            <Link href="/" className="fr-brand">
              <RadarMark />
              <span>
                PCN<span style={{ color: 'var(--color-brand-400)' }}>Watch</span>
              </span>
            </Link>

            {/* Secondary navigation. A scrollable strip on narrow screens rather
                than a hamburger menu: the map is the hero product and hiding it
                behind a menu would bury it. */}
            <nav aria-label="Primary" className="fr-nav">
              {/*
                First in the strip, ahead of the public pages.

                The strip scrolls horizontally on a phone, so anything appended
                to the end of it is off-screen until someone thinks to swipe a
                navigation bar — which nobody does when they are looking for
                something they are not sure exists. A case somebody saved is the
                one thing on this site they already know they want back, so it
                goes where it is visible without being hunted for. The map is
                still on screen beside it at 375px; it has not been buried.
              */}
              <Link href="/cases" className="fr-touch fr-nav-link">
                Your cases
              </Link>
              {NAV.map((item) => (
                <Link key={item.href} href={item.href} className="fr-touch fr-nav-link">
                  {item.label}
                </Link>
              ))}
            </nav>

            {/* The primary action stays beside the brand at every width. On a
                phone this is what someone standing by their car needs first. */}
            {/* The dominant action at every width. See the tests that pin it
                outside the navigation and still styled as the primary. */}
            <Link href="/analyse" className="fr-touch fr-cta">
              Analyse my PCN
            </Link>
          </div>
        </header>

        <main id="main">{children}</main>

        <footer
          style={{
            borderTop: '1px solid var(--border)',
            marginTop: 0,
            paddingBlock: '52px 44px',
            background: 'rgb(3 5 10 / 0.6)',
          }}
        >
          <div className="fr-container fr-stack">
            <div
              style={{
                display: 'grid',
                gap: 32,
                gridTemplateColumns: 'repeat(auto-fit, minmax(min(220px, 100%), 1fr))',
              }}
            >
              <div style={{ maxWidth: 320 }}>
                <Link
                  href="/"
                  className="fr-brand"
                  style={{ marginRight: 0, marginBottom: 14 }}
                >
                  <RadarMark />
                  <span>
                    PCN<span style={{ color: 'var(--color-brand-400)' }}>Watch</span>
                  </span>
                </Link>
                <p style={{ margin: 0, fontSize: 13.5, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                  {COVERAGE_SCOPE.statement} {COVERAGE_SCOPE.explanation}
                </p>
              </div>

              <div>
                <div className="fr-eyebrow" style={{ marginBottom: 12 }}>
                  Explore
                </div>
                <ul style={{ listStyle: 'none', margin: 0, padding: 0, fontSize: 13.5 }}>
                  {NAV.map((item) => (
                    <li key={item.href} style={{ marginBottom: 9 }}>
                      <Link href={item.href} className="fr-footer-link">
                        {item.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>

              <div>
                <div className="fr-eyebrow" style={{ marginBottom: 12 }}>
                  Legal
                </div>
                <ul style={{ listStyle: 'none', margin: 0, padding: 0, fontSize: 13.5 }}>
                  <li style={{ marginBottom: 9 }}>
                    <Link href="/legal/privacy" className="fr-footer-link">
                      Privacy
                    </Link>
                  </li>
                  <li style={{ marginBottom: 9 }}>
                    <Link href="/legal/scope" className="fr-footer-link">
                      What PCNWatch does and does not do
                    </Link>
                  </li>
                  <li style={{ marginBottom: 9 }}>
                    <Link href="/legal/sources" className="fr-footer-link">
                      Data sources
                    </Link>
                  </li>
                </ul>
              </div>

              <div>
                <div className="fr-eyebrow" style={{ marginBottom: 12 }}>
                  Get started
                </div>
                <p style={{ margin: '0 0 14px', fontSize: 13.5, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                  Already have a notice? Start with a photo of it.
                </p>
                <Link href="/analyse" className="fr-touch fr-cta">
                  Analyse my PCN
                </Link>
              </div>
            </div>

            <p
              style={{
                marginTop: 40,
                paddingTop: 22,
                borderTop: '1px solid var(--border)',
                fontSize: 12.5,
                color: 'var(--text-faint)',
                maxWidth: 760,
                lineHeight: 1.6,
              }}
            >
              PCNWatch provides information and document-preparation tools. It does not provide
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

/**
 * The brand mark: a sweep over a location.
 *
 * Same idea as before — a radar finding something — drawn a little heavier so
 * it holds its own beside a bolder wordmark, and tinted with the brand blue
 * rather than the old instrument cyan.
 */
function RadarMark() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="10.2" stroke="var(--color-ink-600)" strokeWidth="1.3" />
      <circle cx="12" cy="12" r="5.8" stroke="var(--color-ink-600)" strokeWidth="1.3" />
      <path
        d="M12 12 L20.2 6.6"
        stroke="var(--color-cyan-400)"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <circle cx="12" cy="12" r="2.4" fill="var(--color-brand-500)" />
      <circle cx="12" cy="12" r="4.6" stroke="var(--color-brand-500)" strokeOpacity="0.45" strokeWidth="1" />
    </svg>
  );
}
