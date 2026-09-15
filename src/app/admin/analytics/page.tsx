import type { Metadata } from 'next';
import Link from 'next/link';
import { checkAdminAccess } from '@/server/admin/auth';
import { getFunnel, type FunnelCounts, type Metric } from '@/server/admin/analytics';
import { fetchTraffic, type TrafficResult } from '@/server/admin/vercel-analytics';
import { parseWindowKey, resolveWindow, WINDOW_KEYS, WINDOW_LABELS } from '@/server/admin/window';
import { Card, formatPence } from '@/components/primitives';

export const metadata: Metadata = {
  title: 'Analytics',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * The operator dashboard: is anyone here, and do they buy anything.
 *
 * Every number on this page is a count, a sum or a ratio of those. No case id,
 * user id, PCN number, registration, address, narrative, evidence or Stripe
 * identifier is queried, and the shapes the two data modules return hold none
 * to render — so there is nothing here to leak by adding a field to the markup.
 *
 * Where a number cannot be trusted it is not shown. An unreachable analytics
 * API and a genuine zero are the same pixels and opposite facts, so the reason
 * is printed instead.
 */
export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await checkAdminAccess();

  if (!access.allowed) {
    /*
     * One page for every denial reason.
     *
     * Not signed in, anonymous, unconfirmed, not on the allow-list and "there
     * is no allow-list" are indistinguishable from out here, so the page cannot
     * be used to find out who the operators are or whether the deployment has
     * any. The sign-in link is safe to show: it grants nothing and refuses to
     * create an account.
     */
    return (
      <div className="fr-container" style={{ paddingBlock: 64, maxWidth: 560 }}>
        <h1 style={{ fontSize: 22, fontWeight: 620 }}>Not available</h1>
        <p style={{ marginTop: 10, color: 'var(--text-muted)' }}>This page is restricted.</p>
        <p style={{ marginTop: 18, fontSize: 14 }}>
          <Link href="/admin/sign-in" className="fr-footer-link">
            Operator sign-in
          </Link>
        </p>
      </div>
    );
  }

  const params = await searchParams;
  const rangeParam = params.range;
  const windowKey = parseWindowKey(Array.isArray(rangeParam) ? rangeParam[0] : rangeParam);
  const window = resolveWindow(windowKey);

  const [funnel, traffic] = await Promise.all([getFunnel(window), fetchTraffic(window)]);

  return (
    <div className="fr-container" style={{ paddingBlock: 36 }}>
      <div className="fr-eyebrow" style={{ marginBottom: 8 }}>
        Internal
      </div>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 16,
          alignItems: 'baseline',
          justifyContent: 'space-between',
        }}
      >
        <h1 style={{ fontSize: 30, fontWeight: 630, margin: 0 }}>Analytics</h1>
        <nav aria-label="Date range" style={{ display: 'flex', gap: 6 }}>
          {WINDOW_KEYS.map((key) => (
            <Link
              key={key}
              href={`/admin/analytics?range=${key}`}
              aria-current={key === windowKey ? 'page' : undefined}
              className="fr-touch fr-pill"
              style={
                key === windowKey
                  ? { background: 'var(--color-brand-600)', color: '#fff', borderColor: 'transparent' }
                  : undefined
              }
            >
              {WINDOW_LABELS[key]}
            </Link>
          ))}
        </nav>
      </div>

      <p style={{ marginTop: 10, color: 'var(--text-muted)', maxWidth: 680, fontSize: 14.5 }}>
        {WINDOW_LABELS[windowKey]}, measured in London time from{' '}
        {window.startUtc.toLocaleString('en-GB', { timeZone: 'Europe/London' })}. Traffic is
        Production only. A figure that cannot be established is shown as unavailable rather than
        as zero.
      </p>

      <ScopeNotice funnel={funnel} />

      {/* Top row */}
      <section style={{ marginTop: 28 }}>
        <div
          style={{
            display: 'grid',
            gap: 10,
            gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
          }}
        >
          <Stat
            label="Unique visitors"
            metric={trafficMetric(traffic, (t) => t.totals.visitors)}
            note="Vercel daily uniques, summed. A return visit on another day counts again."
          />
          <Stat
            label="Page views"
            metric={trafficMetric(traffic, (t) => t.totals.pageViews)}
            note="All Production page views, repeat views included."
          />
          <Stat
            label="Cases reaching assessment"
            metric={funnel.casesReachingAssessment}
            note="Extraction verified and an assessment requested. Not everyone who opened /analyse."
          />
          <Stat
            label="Checkouts"
            metric={funnel.checkouts}
            note={
              funnel.checkoutsUnattributed > 0
                ? `Stripe sessions opened. ${funnel.checkoutsUnattributed} could not be attributed to a mode and are excluded.`
                : 'Stripe Checkout Sessions opened from Production.'
            }
          />
          <Stat
            label="Purchases"
            metric={funnel.purchases}
            note="Webhook-confirmed Live payments. Never a redirect or a success page."
          />
          <Stat
            label="Gross collected"
            metric={funnel.grossCollectedPence}
            format={formatPence}
            note="Actual sum of amounts charged. Gross — refunds are not tracked."
          />
        </div>
      </section>

      {/* Funnel */}
      <section style={{ marginTop: 32 }}>
        <h2 style={{ fontSize: 19, fontWeight: 620, marginBottom: 12 }}>Funnel</h2>
        <Card>
          <FunnelRow
            label="Visitors"
            metric={trafficMetric(traffic, (t) => t.totals.visitors)}
          />
          <FunnelRow
            label="Analyse page views"
            metric={trafficMetric(traffic, (t) => t.analyseViews)}
            note="Page views, not people."
          />
          <FunnelRow label="Cases reaching assessment" metric={funnel.casesReachingAssessment} />
          <FunnelRow label="Assessments completed" metric={funnel.assessmentsCompleted} />
          <FunnelRow
            label="Defence Pack offer views"
            metric={trafficMetric(traffic, (t) => t.defenceOfferViews)}
            note="Offer-page views, not unique customers."
          />
          <FunnelRow label="Checkouts created" metric={funnel.checkouts} />
          <FunnelRow label="Purchases" metric={funnel.purchases} />
          <FunnelRow label="Defence Packs generated" metric={funnel.defencePacks} last />
        </Card>

        <div
          style={{
            marginTop: 10,
            display: 'grid',
            gap: 10,
            gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
          }}
        >
          <Conversion
            label="Visitor → analysis start"
            numerator={trafficMetric(traffic, (t) => t.analyseViews)}
            denominator={trafficMetric(traffic, (t) => t.totals.visitors)}
            note="Views of /analyse against unique visitors. A visitor who opens it twice counts twice, so this can exceed 100%."
          />
          <Conversion
            label="Analysis → checkout"
            numerator={funnel.checkouts}
            denominator={funnel.casesReachingAssessment}
            note="Against cases that reached assessment — the database's measure, not the page views above."
          />
          <Conversion
            label="Checkout → purchase"
            numerator={funnel.purchases}
            denominator={funnel.checkouts}
            note="Webhook-confirmed Live payments against Production sessions opened."
          />
        </div>
      </section>

      {/* Traffic detail */}
      <section style={{ marginTop: 32 }}>
        <div
          style={{
            display: 'grid',
            gap: 12,
            gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
          }}
        >
          <div>
            <h2 style={{ fontSize: 19, fontWeight: 620, marginBottom: 12 }}>Traffic sources</h2>
            <Breakdown
              traffic={traffic}
              pick={(t) => t.topSources}
              emptyLabel="No referrers recorded. Direct visits have no referrer."
            />
          </div>
          <div>
            <h2 style={{ fontSize: 19, fontWeight: 620, marginBottom: 12 }}>Top pages</h2>
            <Breakdown
              traffic={traffic}
              pick={(t) => t.topPages}
              emptyLabel="No page views recorded in this range."
            />
          </div>
        </div>
      </section>

      {/* Trend */}
      <section style={{ marginTop: 32 }}>
        <h2 style={{ fontSize: 19, fontWeight: 620, marginBottom: 12 }}>Daily activity</h2>
        <Trend traffic={traffic} />
      </section>

      {traffic.kind === 'OK' && traffic.traffic.degraded.length > 0 && (
        <p style={{ marginTop: 20, fontSize: 13, color: 'var(--text-faint)' }}>
          Could not read: {traffic.traffic.degraded.join(', ')}. The totals above are unaffected.
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Pieces                                                              */
/* ------------------------------------------------------------------ */

/** Lifts a traffic reading into the same Metric shape the funnel uses. */
function trafficMetric(
  traffic: TrafficResult,
  pick: (t: Extract<TrafficResult, { kind: 'OK' }>['traffic']) => number | null,
): Metric {
  if (traffic.kind === 'NOT_CONFIGURED') {
    return { kind: 'UNAVAILABLE', reason: `Not configured: ${traffic.missing.join(', ')}.` };
  }
  if (traffic.kind === 'UNAVAILABLE') return { kind: 'UNAVAILABLE', reason: traffic.reason };
  const picked = pick(traffic.traffic);
  return picked === null
    ? { kind: 'UNAVAILABLE', reason: 'Vercel did not return this breakdown.' }
    : { kind: 'VALUE', value: picked };
}

function ScopeNotice({ funnel }: { funnel: FunnelCounts }) {
  if (funnel.scope === 'PRODUCTION_ONLY') return null;
  return (
    <Card style={{ marginTop: 20 }}>
      <strong style={{ fontSize: 14.5 }}>Case and Defence Pack counts are unavailable</strong>
      <p style={{ margin: '6px 0 0', fontSize: 13.5, color: 'var(--text-muted)', lineHeight: 1.6 }}>
        {funnel.scope === 'SHARED_WITH_PREVIEW'
          ? 'This Supabase project is shared with Preview deployments, and no column records which deployment wrote a row, so Preview testing cannot be separated from customer activity.'
          : 'ANALYTICS_DB_SCOPE is not set, so it is not established whether Preview writes into this Supabase project. Set it to PRODUCTION_ONLY once the two NEXT_PUBLIC_SUPABASE_URL values have been compared.'}{' '}
        Payments are unaffected: a Live payment can only come from Production.
      </p>
    </Card>
  );
}

function Stat({
  label,
  metric,
  note,
  format,
}: {
  label: string;
  metric: Metric;
  note: string;
  format?: (value: number) => string;
}) {
  return (
    <Card>
      <div className="fr-eyebrow" style={{ marginBottom: 6 }}>
        {label}
      </div>
      {metric.kind === 'VALUE' ? (
        <div style={{ fontSize: 26, fontWeight: 640, lineHeight: 1.1 }}>
          {format ? format(metric.value) : metric.value.toLocaleString('en-GB')}
        </div>
      ) : (
        <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-faint)' }}>Unavailable</div>
      )}
      <p style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--text-faint)', lineHeight: 1.5 }}>
        {metric.kind === 'VALUE' ? note : metric.reason}
      </p>
    </Card>
  );
}

function FunnelRow({
  label,
  metric,
  note,
  last = false,
}: {
  label: string;
  metric: Metric;
  note?: string;
  last?: boolean;
}) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        gap: 14,
        alignItems: 'baseline',
        paddingBlock: 9,
        borderBottom: last ? 'none' : '1px solid var(--border)',
      }}
    >
      <span style={{ fontSize: 14.5 }}>
        {label}
        {note && (
          <span style={{ color: 'var(--text-faint)', fontSize: 12, marginLeft: 8 }}>{note}</span>
        )}
      </span>
      <span
        style={{
          fontSize: metric.kind === 'VALUE' ? 16 : 12.5,
          fontWeight: metric.kind === 'VALUE' ? 640 : 500,
          color: metric.kind === 'VALUE' ? 'var(--text)' : 'var(--text-faint)',
          textAlign: 'right',
          maxWidth: '55%',
        }}
      >
        {metric.kind === 'VALUE' ? metric.value.toLocaleString('en-GB') : 'Unavailable'}
      </span>
    </div>
  );
}

function Conversion({
  label,
  numerator,
  denominator,
  note,
}: {
  label: string;
  numerator: Metric;
  denominator: Metric;
  note?: string;
}) {
  /*
   * A rate needs both sides and a denominator above zero. Anything else prints
   * a dash: "0%" out of nothing is a claim about conversion that the data does
   * not support.
   */
  const percentage =
    numerator.kind === 'VALUE' && denominator.kind === 'VALUE' && denominator.value > 0
      ? ((numerator.value / denominator.value) * 100).toFixed(1)
      : null;

  return (
    <Card>
      <div className="fr-eyebrow" style={{ marginBottom: 6 }}>
        {label}
      </div>
      <div style={{ fontSize: 22, fontWeight: 640 }}>
        {percentage === null ? '—' : `${percentage}%`}
      </div>
      <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--text-faint)', lineHeight: 1.5 }}>
        {percentage === null
          ? 'Not computable for this range.'
          : (note ?? 'Both sides measured over the same range.')}
      </p>
    </Card>
  );
}

function Breakdown({
  traffic,
  pick,
  emptyLabel,
}: {
  traffic: TrafficResult;
  pick: (t: Extract<TrafficResult, { kind: 'OK' }>['traffic']) => readonly {
    label: string;
    pageViews: number;
  }[];
  emptyLabel: string;
}) {
  if (traffic.kind !== 'OK') {
    return (
      <Card>
        <p style={{ margin: 0, fontSize: 13.5, color: 'var(--text-faint)' }}>
          {traffic.kind === 'NOT_CONFIGURED'
            ? `Not configured: ${traffic.missing.join(', ')}.`
            : traffic.reason}
        </p>
      </Card>
    );
  }

  const rows = pick(traffic.traffic);
  if (rows.length === 0) {
    return (
      <Card>
        <p style={{ margin: 0, fontSize: 13.5, color: 'var(--text-faint)' }}>{emptyLabel}</p>
      </Card>
    );
  }

  const top = rows[0]?.pageViews ?? 1;

  return (
    <Card padded={false}>
      <ul style={{ listStyle: 'none', margin: 0, padding: '6px 0' }}>
        {rows.map((row) => (
          <li key={row.label} style={{ padding: '7px 16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13.5 }}>
              <span
                style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                title={row.label}
              >
                {row.label}
              </span>
              <strong>{row.pageViews.toLocaleString('en-GB')}</strong>
            </div>
            <div
              aria-hidden="true"
              style={{
                marginTop: 4,
                height: 3,
                borderRadius: 2,
                background: 'var(--color-brand-600)',
                opacity: 0.65,
                width: `${Math.max(2, Math.round((row.pageViews / Math.max(top, 1)) * 100))}%`,
              }}
            />
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Trend({ traffic }: { traffic: TrafficResult }) {
  if (traffic.kind !== 'OK') {
    return (
      <Card>
        <p style={{ margin: 0, fontSize: 13.5, color: 'var(--text-faint)' }}>
          {traffic.kind === 'NOT_CONFIGURED'
            ? `Not configured: ${traffic.missing.join(', ')}.`
            : traffic.reason}
        </p>
      </Card>
    );
  }

  const rows = traffic.traffic.daily;
  if (rows.length === 0) {
    return (
      <Card>
        <p style={{ margin: 0, fontSize: 13.5, color: 'var(--text-faint)' }}>
          No daily breakdown available for this range.
        </p>
      </Card>
    );
  }

  const peak = Math.max(...rows.map((row) => row.pageViews), 1);

  return (
    <Card padded={false}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13.5 }}>
        <thead>
          <tr style={{ textAlign: 'left', color: 'var(--text-faint)' }}>
            <th style={{ padding: '10px 16px', fontWeight: 560 }}>Day</th>
            <th style={{ padding: '10px 16px', fontWeight: 560 }}>Visitors</th>
            <th style={{ padding: '10px 16px', fontWeight: 560, width: '55%' }}>Page views</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.date} style={{ borderTop: '1px solid var(--border)' }}>
              <td style={{ padding: '8px 16px', whiteSpace: 'nowrap' }}>{row.date}</td>
              <td style={{ padding: '8px 16px' }}>{row.visitors.toLocaleString('en-GB')}</td>
              <td style={{ padding: '8px 16px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div
                    aria-hidden="true"
                    style={{
                      height: 8,
                      borderRadius: 2,
                      background: 'var(--color-brand-600)',
                      opacity: 0.7,
                      width: `${Math.max(2, Math.round((row.pageViews / peak) * 100))}%`,
                      minWidth: 2,
                    }}
                  />
                  <span>{row.pageViews.toLocaleString('en-GB')}</span>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
