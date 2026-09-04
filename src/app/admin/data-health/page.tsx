import type { Metadata } from 'next';
import { checkAdminAccess } from '@/server/admin/auth';
import { getDataHealth, STALENESS_THRESHOLD_HOURS } from '@/server/admin/data-health';
import { Card, formatDateTime } from '@/components/primitives';

export const metadata: Metadata = {
  title: 'Data health',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function DataHealthPage() {
  const access = await checkAdminAccess();

  if (!access.allowed) {
    // The same page for every denial reason, so it cannot be used to probe who is
    // an admin or whether an allow-list is configured.
    return (
      <div className="fr-container" style={{ paddingBlock: 64, maxWidth: 560 }}>
        <h1 style={{ fontSize: 22, fontWeight: 620 }}>Not available</h1>
        <p style={{ marginTop: 10, color: 'var(--text-muted)' }}>
          This page is restricted.
        </p>
      </div>
    );
  }

  const health = await getDataHealth();

  return (
    <div className="fr-container" style={{ paddingBlock: 36 }}>
      <div className="fr-eyebrow" style={{ marginBottom: 8 }}>
        Internal
      </div>
      <h1 style={{ fontSize: 30, fontWeight: 630 }}>Data health</h1>
      <p style={{ marginTop: 10, color: 'var(--text-muted)', maxWidth: 620 }}>
        Source freshness, ingestion outcomes and model-output validation. A source
        with no successful run is reported as stale, never as healthy.
      </p>

      {/* Integrations */}
      <section style={{ marginTop: 32 }}>
        <h2 style={{ fontSize: 19, fontWeight: 620, marginBottom: 12 }}>Integrations</h2>
        <div
          style={{
            display: 'grid',
            gap: 10,
            gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
          }}
        >
          {health.integrations.map((integration) => (
            <Card key={integration.name}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <strong style={{ fontSize: 14.5, textTransform: 'capitalize' }}>
                  {integration.name}
                </strong>
                <StatusDot ok={integration.configured} />
              </div>
              <p style={{ margin: '6px 0 0', fontSize: 12.5, color: 'var(--text-faint)' }}>
                {integration.configured
                  ? 'Configured'
                  : `Missing: ${integration.missing.join(', ')}`}
              </p>
            </Card>
          ))}
        </div>
      </section>

      {/* Stuck runs */}
      {health.stuckRuns.length > 0 && (
        <section style={{ marginTop: 32 }}>
          <h2 style={{ fontSize: 19, fontWeight: 620, marginBottom: 12 }}>Stuck runs</h2>
          <Card style={{ borderColor: 'var(--color-urgent)' }}>
            <p style={{ margin: '0 0 10px', fontSize: 14 }}>
              These runs started but never finished. They almost certainly crashed.
            </p>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13.5 }}>
              {health.stuckRuns.map((run) => (
                <li key={run.id}>
                  <code>{run.sourceSlug}</code> — started {formatDateTime(run.startedAt)} (
                  {run.id.slice(0, 8)})
                </li>
              ))}
            </ul>
          </Card>
        </section>
      )}

      {/* Sources */}
      <section style={{ marginTop: 32 }}>
        <h2 style={{ fontSize: 19, fontWeight: 620, marginBottom: 12 }}>Sources</h2>
        {!health.datastoreAvailable ? (
          <Card>
            <p style={{ margin: 0, color: 'var(--text-muted)' }}>
              The datastore is not reachable, so source health cannot be reported. This is not a
              statement that the sources are healthy.
            </p>
          </Card>
        ) : health.sources.length === 0 ? (
          <Card>
            <p style={{ margin: 0, color: 'var(--text-muted)' }}>
              No sources have been registered yet. A source appears here after its first ingestion
              run.
            </p>
          </Card>
        ) : (
          <div className="fr-scroll-x">
            <table
              style={{
                width: '100%',
                minWidth: 780,
                borderCollapse: 'collapse',
                fontSize: 13.5,
              }}
            >
              <thead>
                <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border-strong)' }}>
                  {['Source', 'Status', 'Freshness', 'Inserted', 'Updated', 'Rejected', 'No geometry', 'Top rejections'].map(
                    (heading) => (
                      <th
                        key={heading}
                        style={{ padding: '9px 12px 9px 0', fontWeight: 600, fontSize: 12 }}
                      >
                        {heading}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {health.sources.map((source) => (
                  <tr key={source.sourceSlug} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '11px 12px 11px 0' }}>
                      <strong style={{ fontWeight: 600 }}>{source.sourceName}</strong>
                      <div style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>
                        {source.sourceSlug}
                      </div>
                    </td>
                    <td style={{ padding: '11px 12px 11px 0' }}>
                      <span
                        style={{
                          color:
                            source.lastRunStatus === 'SUCCEEDED'
                              ? 'var(--color-ok)'
                              : source.lastRunStatus === 'FAILED'
                                ? 'var(--color-urgent)'
                                : 'var(--color-warn)',
                        }}
                      >
                        {source.lastRunStatus ?? 'Never run'}
                      </span>
                    </td>
                    <td className="fr-numeric" style={{ padding: '11px 12px 11px 0' }}>
                      {source.freshnessHours === null ? (
                        <span style={{ color: 'var(--color-urgent)' }}>No successful run</span>
                      ) : (
                        <span style={{ color: source.stale ? 'var(--color-urgent)' : 'inherit' }}>
                          {source.freshnessHours < 1
                            ? '< 1h'
                            : `${Math.round(source.freshnessHours)}h`}
                          {source.stale ? ` (> ${STALENESS_THRESHOLD_HOURS}h)` : ''}
                        </span>
                      )}
                    </td>
                    <td className="fr-numeric" style={{ padding: '11px 12px 11px 0' }}>
                      {source.rowsInserted.toLocaleString('en-GB')}
                    </td>
                    <td className="fr-numeric" style={{ padding: '11px 12px 11px 0' }}>
                      {source.rowsUpdated.toLocaleString('en-GB')}
                    </td>
                    <td className="fr-numeric" style={{ padding: '11px 12px 11px 0' }}>
                      <span style={{ color: source.rowsRejected > 0 ? 'var(--color-warn)' : 'inherit' }}>
                        {source.rowsRejected.toLocaleString('en-GB')}
                      </span>
                    </td>
                    <td className="fr-numeric" style={{ padding: '11px 12px 11px 0' }}>
                      {source.notGeolocated.toLocaleString('en-GB')}
                    </td>
                    <td style={{ padding: '11px 0', fontSize: 12 }}>
                      {source.topErrorCodes.length === 0 ? (
                        <span style={{ color: 'var(--text-faint)' }}>None</span>
                      ) : (
                        source.topErrorCodes.map((e) => (
                          <div key={e.code}>
                            <code>{e.code}</code> × {e.count}
                          </div>
                        ))
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* AI */}
      <section style={{ marginTop: 32 }}>
        <h2 style={{ fontSize: 19, fontWeight: 620, marginBottom: 12 }}>Model output validation</h2>
        {health.ai === null ? (
          <Card>
            <p style={{ margin: 0, color: 'var(--text-muted)' }}>Not available.</p>
          </Card>
        ) : (
          <div
            style={{
              display: 'grid',
              gap: 10,
              gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
            }}
          >
            {[
              { label: 'Calls', value: health.ai.totalCalls, tone: 'neutral' },
              { label: 'Accepted', value: health.ai.accepted, tone: 'ok' },
              { label: 'Schema rejected', value: health.ai.schemaRejected, tone: 'warn' },
              { label: 'Citation rejected', value: health.ai.citationRejected, tone: 'urgent' },
              { label: 'Errors', value: health.ai.errors, tone: 'warn' },
            ].map((stat) => (
              <Card key={stat.label}>
                <div className="fr-eyebrow" style={{ marginBottom: 5 }}>
                  {stat.label}
                </div>
                <div
                  className="fr-numeric"
                  style={{
                    fontSize: 24,
                    fontWeight: 620,
                    color:
                      stat.value > 0 && stat.tone === 'urgent'
                        ? 'var(--color-urgent)'
                        : stat.value > 0 && stat.tone === 'warn'
                          ? 'var(--color-warn)'
                          : 'inherit',
                  }}
                >
                  {stat.value.toLocaleString('en-GB')}
                </div>
              </Card>
            ))}
          </div>
        )}
        <p style={{ marginTop: 12, fontSize: 12.5, color: 'var(--text-faint)', maxWidth: 620 }}>
          A non-zero citation-rejected count means a model attempted to cite something that is not
          in the approved reference store, or that was not supplied for that case. Those responses
          were discarded, not shown to anyone.
        </p>
      </section>
    </div>
  );
}

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span
      aria-label={ok ? 'Configured' : 'Not configured'}
      style={{
        width: 9,
        height: 9,
        borderRadius: '50%',
        background: ok ? 'var(--color-ok)' : 'var(--color-urgent)',
        marginTop: 5,
        flexShrink: 0,
      }}
    />
  );
}
