import Link from 'next/link';

/**
 * The four states a case page can be in besides "found".
 *
 * NOT_FOUND deliberately reads the same whether the case does not exist or
 * belongs to someone else — RLS returns no row in both cases and the UI must not
 * distinguish them, or it becomes a way to test whether a case id is real.
 */
export function CaseUnavailable({
  kind,
  correlationId,
}: {
  kind: 'NOT_FOUND' | 'NOT_SIGNED_IN' | 'UNAVAILABLE';
  correlationId?: string;
}) {
  const content = {
    NOT_FOUND: {
      title: 'Case not found',
      body: 'We could not find that case. Check the link, or open it from your list of cases.',
    },
    NOT_SIGNED_IN: {
      title: 'Sign in to see this case',
      body: 'Cases are private to the person who created them, so you need to be signed in to open one.',
    },
    UNAVAILABLE: {
      title: 'Case temporarily unavailable',
      body: 'We could not load this case just now. Nothing has been lost — this is a problem on our side. Please try again shortly.',
    },
  }[kind];

  return (
    <div className="fr-container" style={{ paddingBlock: 64, maxWidth: 620 }}>
      <h1 style={{ fontSize: 24, fontWeight: 620 }}>{content.title}</h1>
      <p style={{ marginTop: 12, color: 'var(--text-muted)', fontSize: 16 }}>{content.body}</p>
      {correlationId && (
        <p style={{ marginTop: 12, fontSize: 12.5, color: 'var(--text-faint)' }}>
          Reference {correlationId}
        </p>
      )}
      <p style={{ marginTop: 24 }}>
        <Link href="/analyse">Analyse a notice →</Link>
      </p>
    </div>
  );
}
