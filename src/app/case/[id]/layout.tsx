import type { Metadata } from 'next';

/**
 * Case pages contain a user's own data and must never be indexed, cached by a
 * shared cache, or statically generated.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true },
};

export const dynamic = 'force-dynamic';

export default function CaseLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
