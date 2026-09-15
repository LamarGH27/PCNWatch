'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';

/**
 * Operator sign-in by magic link.
 *
 * `shouldCreateUser: false` is the whole security posture of this form. Without
 * it, Supabase creates an account for any address typed in, which would make
 * this a public signup surface on an admin path; with it, the form can only
 * send a link to an account that already exists, and those are created by hand
 * in the Supabase dashboard. Being on the allow-list is still a separate and
 * authoritative requirement — an existing account that is not listed can sign
 * in and still sees nothing.
 *
 * The response is deliberately the same whether or not the address matched
 * anything. Otherwise the form answers "is this person an operator here?" for
 * anybody who asks.
 */
export function SignInForm() {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'IDLE' | 'SENDING' | 'SENT' | 'UNAVAILABLE'>('IDLE');

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (state === 'SENDING') return;

    const supabase = createClient();
    if (!supabase) {
      setState('UNAVAILABLE');
      return;
    }

    setState('SENDING');
    try {
      await supabase.auth.signInWithOtp({
        email: email.trim(),
        options: {
          shouldCreateUser: false,
          // The callback route, not the dashboard: the link returns a PKCE
          // code that has to be exchanged for a session somewhere that can
          // write a cookie.
          emailRedirectTo: `${window.location.origin}/admin/auth/callback`,
        },
      });
    } catch {
      // Falls through to the same message. A network failure and a refusal are
      // reported identically for the reason above.
    }
    setState('SENT');
  }

  if (state === 'SENT') {
    return (
      <p style={{ margin: 0, fontSize: 15, color: 'var(--text-muted)', lineHeight: 1.6 }}>
        If that address belongs to an operator account, a sign-in link is on its way. The link
        opens the dashboard directly.
      </p>
    );
  }

  return (
    <form onSubmit={onSubmit} style={{ display: 'grid', gap: 12 }}>
      <label htmlFor="operator-email" style={{ fontSize: 14, color: 'var(--text-muted)' }}>
        Operator email address
      </label>
      <input
        id="operator-email"
        name="email"
        type="email"
        autoComplete="email"
        required
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        style={{
          padding: '10px 12px',
          fontSize: 15,
          borderRadius: 8,
          border: '1px solid var(--border)',
          background: 'var(--surface)',
          color: 'var(--text)',
        }}
      />
      <button type="submit" className="fr-touch fr-btn fr-btn-primary" disabled={state === 'SENDING'}>
        {state === 'SENDING' ? 'Sending…' : 'Email me a sign-in link'}
      </button>
      {state === 'UNAVAILABLE' && (
        <p style={{ margin: 0, fontSize: 13.5, color: 'var(--text-faint)' }}>
          Sign-in is not available on this deployment.
        </p>
      )}
    </form>
  );
}
