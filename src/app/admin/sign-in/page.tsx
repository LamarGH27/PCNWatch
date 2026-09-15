import type { Metadata } from 'next';
import { SignInForm } from './SignInForm';

export const metadata: Metadata = {
  title: 'Operator sign-in',
  robots: { index: false, follow: false },
};

/**
 * Where an operator gets an email-bearing session.
 *
 * PCNWatch customers are anonymous Supabase users with no address, so the
 * allow-list in `checkAdminAccess` had nothing to match and the admin pages
 * were unreachable by anybody. This is the only route that produces a session
 * the allow-list can recognise.
 *
 * It grants nothing by itself. Signing in successfully and not being on
 * `ADMIN_EMAIL_ALLOWLIST` gets exactly the same "Not available" page as signing
 * in never did.
 */
export default function AdminSignInPage() {
  return (
    <div className="fr-container" style={{ paddingBlock: 64, maxWidth: 440 }}>
      <div className="fr-eyebrow" style={{ marginBottom: 8 }}>
        Internal
      </div>
      <h1 style={{ fontSize: 24, fontWeight: 630 }}>Operator sign-in</h1>
      <p style={{ margin: '10px 0 24px', fontSize: 14.5, color: 'var(--text-muted)', lineHeight: 1.6 }}>
        For PCNWatch operators. This is not a customer sign-in — a case you saved belongs to the
        browser you saved it in and does not need an account.
      </p>
      <SignInForm />
    </div>
  );
}
