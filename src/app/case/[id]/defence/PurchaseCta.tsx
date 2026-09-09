'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The paid door.
 *
 * Three things happen here and it is worth being clear which is which.
 *
 * Starting a payment is a POST that sends one thing — the case id. It does not
 * send a price, a product or an entitlement, because the server does not read
 * one; everything about what is being bought is decided there.
 *
 * Coming back from Stripe is not evidence of anything. `?checkout=returned`
 * means the browser was redirected, which a user can do by typing it. So the
 * return does not unlock the pack: it starts asking the server whether the
 * webhook has landed, and the server answers from persisted rows.
 *
 * Waiting is the part users actually feel. The webhook usually arrives before
 * the redirect does, but "usually" is not "always", and a blank page that says
 * nothing while a customer has just been charged is the worst version of this
 * screen. So the wait is explicit, and when it runs long it says what to do.
 */

/** How long to keep asking before telling the user to come back. */
const POLL_ATTEMPTS = 12;
const POLL_INTERVAL_MS = 2500;

type Phase = 'IDLE' | 'STARTING' | 'CONFIRMING' | 'SLOW' | 'CANCELLED';

interface EntitlementResponse {
  readonly ok?: boolean;
  readonly entitled?: boolean;
  readonly attempt?: 'NONE' | 'PENDING' | 'FAILED';
}

export function PurchaseCta({
  caseId,
  priceLabel,
  paymentsEnabled,
  returnState,
}: {
  caseId: string;
  priceLabel: string;
  paymentsEnabled: boolean;
  /** From the redirect. A hint about what to show, never a grant. */
  returnState: 'returned' | 'cancelled' | null;
}) {
  const [phase, setPhase] = useState<Phase>(
    returnState === 'returned' ? 'CONFIRMING' : returnState === 'cancelled' ? 'CANCELLED' : 'IDLE',
  );
  const [problem, setProblem] = useState<string | null>(null);
  const cancelled = useRef(false);

  useEffect(() => {
    return () => {
      cancelled.current = true;
    };
  }, []);

  /*
   * Polling, not a countdown.
   *
   * Reloading the page is what turns an entitlement into the pack, because the
   * pack is rendered on the server behind the same access check. Asking first
   * means we only reload once there is something to show.
   */
  useEffect(() => {
    if (returnState !== 'returned') return;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const ask = async () => {
      attempts += 1;
      try {
        const response = await fetch(`/api/cases/${caseId}/entitlement`, { cache: 'no-store' });
        const result = (await response.json()) as EntitlementResponse;
        if (cancelled.current) return;
        if (result.ok && result.entitled) {
          window.location.replace(`/case/${caseId}/defence`);
          return;
        }
      } catch {
        // A failed poll is not a failed payment. Try again.
      }
      if (cancelled.current) return;
      if (attempts >= POLL_ATTEMPTS) {
        setPhase('SLOW');
        return;
      }
      timer = setTimeout(() => void ask(), POLL_INTERVAL_MS);
    };

    timer = setTimeout(() => void ask(), 800);
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [caseId, returnState]);

  const start = useCallback(async () => {
    setProblem(null);
    setPhase('STARTING');
    try {
      const response = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ caseId }),
      });
      const result = (await response.json()) as {
        ok?: boolean;
        url?: string;
        alreadyEntitled?: boolean;
        message?: string;
      };

      if (result.ok && result.alreadyEntitled) {
        window.location.replace(`/case/${caseId}/defence`);
        return;
      }
      if (!result.ok || !result.url) {
        setPhase('IDLE');
        setProblem(
          result.message ?? 'We could not start the payment. Nothing has been charged.',
        );
        return;
      }
      // Stripe hosts the card form. Nothing about the card touches this app.
      window.location.assign(result.url);
    } catch {
      setPhase('IDLE');
      setProblem('We could not reach the server. Nothing has been charged.');
    }
  }, [caseId]);

  if (phase === 'CONFIRMING') {
    return (
      <div style={noticeStyle} role="status" aria-live="polite">
        <strong style={{ fontSize: 15 }}>Payment received. Preparing your Defence Pack…</strong>
        <p style={paragraph}>
          Stripe confirms your payment with our server directly, which takes a few seconds. This
          page will open your pack as soon as it is confirmed.
        </p>
      </div>
    );
  }

  if (phase === 'SLOW') {
    return (
      <div style={noticeStyle} role="status" aria-live="polite">
        <strong style={{ fontSize: 15 }}>Your payment is still being confirmed.</strong>
        <p style={paragraph}>
          Nothing is lost. Your pack unlocks the moment the confirmation arrives — reload this page
          in a minute or two. If it has not appeared within an hour, contact us with the case link
          and we will sort it out.
        </p>
        <button
          type="button"
          className="fr-touch fr-btn fr-btn-secondary"
          style={{ marginTop: 12 }}
          onClick={() => window.location.reload()}
        >
          Check again
        </button>
      </div>
    );
  }

  return (
    <div style={{ marginTop: 16 }}>
      {phase === 'CANCELLED' && (
        <p style={{ ...paragraph, marginTop: 0 }} role="status">
          Payment cancelled. Nothing has been charged, and your case is exactly as you left it.
        </p>
      )}

      {paymentsEnabled ? (
        <button
          type="button"
          className="fr-touch fr-btn fr-btn-primary"
          onClick={() => void start()}
          disabled={phase === 'STARTING'}
          style={primary}
        >
          {phase === 'STARTING' ? 'Opening secure checkout…' : `Build my challenge — ${priceLabel}`}
        </button>
      ) : (
        <p style={{ ...paragraph, marginTop: 0 }}>
          Payments are not open on this deployment yet.
        </p>
      )}

      {problem && (
        <p style={{ ...paragraph, color: 'var(--color-urgent)' }} role="alert">
          {problem}
        </p>
      )}

      {paymentsEnabled && (
        <p style={{ margin: '10px 0 0', fontSize: 13, color: 'var(--text-faint)' }}>
          One-off payment, taken securely by Stripe. We never see your card details.
        </p>
      )}
    </div>
  );
}

const paragraph = {
  margin: '8px 0 0',
  fontSize: 14.5,
  color: 'var(--text-muted)',
} as const;

const noticeStyle = {
  marginTop: 16,
  padding: 16,
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-md)',
  background: 'var(--surface-raised, transparent)',
} as const;

/* Empty: the button now carries `fr-btn fr-btn-primary`, so its appearance
   lives with every other primary action rather than in this file. */
const primary = {} as const;


