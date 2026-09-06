import Link from 'next/link';
import { listCases } from '@/server/repositories/cases';
import { maskPcnNumber } from '@/server/cases/assess-verified';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Your cases · PCNWatch',
  // Nothing here belongs in a search index: it is one person's private list.
  robots: { index: false, follow: false },
};

/**
 * The way back to a saved case.
 *
 * Everything shown comes through the request-scoped client, so RLS decides what
 * is on the page. There is no user id in the query and no ownership check in
 * this file — a case belonging to somebody else does not come back at all,
 * which is a stronger guarantee than remembering to filter.
 *
 * The PCN number is masked. A case list is the kind of page people open on a
 * train, and the full number is the one thing on it worth shoulder-surfing.
 */
export default async function CasesPage() {
  const result = await listCases();

  return (
    <div className="fr-container" style={{ paddingBlock: 28, maxWidth: 780 }}>
      <h1 style={{ fontSize: 'clamp(23px, 3.4vw, 30px)', fontWeight: 630 }}>Your cases</h1>

      {result.kind === 'NOT_SIGNED_IN' && (
        <Empty
          heading="No cases in this browser"
          body="Cases are saved to the browser you created them in — there is no account and no password. If you analysed a notice on another device, or cleared your browsing data since, this list will be empty even though nothing went wrong."
        />
      )}

      {result.kind === 'UNAVAILABLE' && (
        <Empty
          heading="We cannot reach your cases just now"
          body="Nothing has been lost. Try again shortly."
          reference={result.correlationId}
        />
      )}

      {result.kind === 'OK' && result.cases.length === 0 && (
        <Empty
          heading="You have not saved a case yet"
          body="Upload a penalty charge notice and PCNWatch will read it, check it with you and save it here."
        />
      )}

      {result.kind === 'OK' && result.cases.length > 0 && (
        <>
          <p style={{ marginTop: 8, fontSize: 14.5, color: 'var(--text-muted)', lineHeight: 1.5 }}>
            Saved privately in this browser. Only you can open these.
          </p>
          <ul style={{ listStyle: 'none', padding: 0, margin: '20px 0 0', display: 'grid', gap: 12 }}>
            {result.cases.map((item) => (
              <li key={item.id}>
                <Link
                  href={`/case/${item.id}`}
                  className="fr-touch"
                  style={{
                    display: 'block',
                    padding: '14px 16px',
                    border: '1px solid var(--border-strong)',
                    borderRadius: 'var(--radius-md)',
                    background: 'var(--surface-raised)',
                    color: 'var(--text)',
                    textDecoration: 'none',
                  }}
                >
                  <div style={{ display: 'flex', gap: 10, justifyContent: 'space-between', flexWrap: 'wrap' }}>
                    <strong style={{ fontSize: 15.5 }}>
                      {item.authorityName ?? 'Authority not recorded'}
                    </strong>
                    <span style={{ fontSize: 12.5, color: 'var(--text-faint)' }}>
                      {STATUS_LABELS[item.status] ?? item.status}
                    </span>
                  </div>
                  <div style={{ marginTop: 4, fontSize: 14, color: 'var(--text-muted)' }}>
                    {item.pcnNumber ? maskPcnNumber(item.pcnNumber) : 'No PCN number recorded'}
                    {item.contraventionCode ? ` · code ${item.contraventionCode}` : ''}
                  </div>
                  <div style={{ marginTop: 2, fontSize: 13, color: 'var(--text-faint)' }}>
                    {item.locationText ?? 'Location not recorded'}
                    {item.incidentDate ? ` · ${item.incidentDate}` : ''}
                  </div>
                  {item.updatedAt && (
                    <div style={{ marginTop: 6, fontSize: 12.5, color: 'var(--text-faint)' }}>
                      Last updated {item.updatedAt.slice(0, 10)}
                    </div>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}

      <div style={{ marginTop: 24, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <Link href="/analyse" className="fr-touch" style={action}>
          Analyse a notice
        </Link>
      </div>

      <p style={{ marginTop: 24, fontSize: 12.5, color: 'var(--text-faint)', lineHeight: 1.55 }}>
        There is no account behind this list. The way back to your cases is stored in this browser,
        so clearing your browsing data, using private browsing, or switching device will lose it.
        What you wrote in your own words was never saved at all.
      </p>
    </div>
  );
}

const STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Not finished',
  VERIFIED: 'Details confirmed',
  ASSESSED: 'Assessed',
  ARCHIVED: 'Archived',
};

function Empty({
  heading,
  body,
  reference,
}: {
  heading: string;
  body: string;
  reference?: string;
}) {
  return (
    <div className="fr-panel" style={{ padding: '18px 20px', marginTop: 18 }} role="status">
      <strong style={{ fontSize: 16 }}>{heading}</strong>
      <p style={{ margin: '8px 0 0', fontSize: 14.5, color: 'var(--text-muted)', lineHeight: 1.55 }}>
        {body}
      </p>
      {reference && (
        <p style={{ margin: '8px 0 0', fontSize: 12.5, color: 'var(--text-faint)' }}>
          Reference: {reference}
        </p>
      )}
    </div>
  );
}

const action: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '0 18px',
  border: '1px solid var(--text)',
  borderRadius: 'var(--radius-md)',
  background: 'var(--text)',
  color: 'var(--surface)',
  fontSize: 15,
  fontWeight: 600,
  textDecoration: 'none',
};
