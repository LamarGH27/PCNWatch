import type { Metadata } from 'next';
import Link from 'next/link';
import { COVERAGE_SCOPE } from '@/core/coverage/coverage';
import { getCoverage, getHotspots, type HotspotRow } from '@/server/repositories/enforcement';
import { getContravention } from '@/core/reference/store';
import {
  Card,
  CoverageNotice,
  MeasurementBasis,
  ScoreBadge,
  ScoreExplanation,
  ScoreUnavailable,
} from '@/components/primitives';

export const metadata: Metadata = {
  title: 'Enforcement hotspots',
  description:
    'Camden locations ranked by historical PCN enforcement activity, with the dominant contravention, peak enforcement window and data confidence for each.',
  alternates: { canonical: '/hotspots' },
};

export const revalidate = 900;

const AUTHORITY = COVERAGE_SCOPE.liveAuthoritySlugs[0];

type Period = '30D' | '90D' | '12M';

const PERIOD_LABELS: Record<Period, string> = {
  '30D': 'Last 30 days',
  '90D': 'Last 90 days',
  '12M': 'Last 12 months',
};

export default async function HotspotsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const period = parsePeriod(params.period);
  const contravention = parseCode(params.code);

  const coverage = await getCoverage(AUTHORITY);
  const hotspots = coverage.canShowActivity
    ? await getHotspots({ authoritySlug: AUTHORITY, periodKey: period, contraventionCode: contravention })
    : null;

  return (
    <div className="fr-container" style={{ paddingBlock: 40 }}>
      <div className="fr-eyebrow" style={{ marginBottom: 8 }}>
        Enforcement hotspots · {COVERAGE_SCOPE.shortStatement}
      </div>
      <h1 style={{ fontSize: 'clamp(26px, 4vw, 38px)', fontWeight: 630, maxWidth: 720 }}>
        Where enforcement activity concentrates
      </h1>
      <p style={{ marginTop: 12, maxWidth: 640, color: 'var(--text-muted)', fontSize: 16 }}>
        Locations ranked by their Ticket Activity Score, which compares historical PCN activity
        within the data we hold. Ranking high does not mean parking is prohibited, and ranking low
        does not mean it is allowed.
      </p>

      <div style={{ marginTop: 14 }}>
        <MeasurementBasis />
      </div>

      <div style={{ marginTop: 22, maxWidth: 620 }}>
        <CoverageNotice coverage={coverage} />
      </div>

      <Filters period={period} code={contravention} />

      <div style={{ marginTop: 24 }}>
        {!coverage.canShowActivity ? (
          <Card>
            <p style={{ margin: 0, color: 'var(--text-muted)' }}>
              Rankings appear here once enforcement data has been ingested for a covered authority.
              We do not show placeholder rankings.
            </p>
          </Card>
        ) : hotspots === null || !hotspots.ok ? (
          <Card>
            <h2 style={{ fontSize: 17, fontWeight: 620, marginBottom: 8 }}>
              Data temporarily unavailable
            </h2>
            <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 15 }}>
              We could not load the rankings just now. This is a problem on our side, not a
              statement about enforcement activity.
              {hotspots && !hotspots.ok && (
                <span style={{ display: 'block', marginTop: 8, fontSize: 12.5 }}>
                  Reference {hotspots.correlationId}
                </span>
              )}
            </p>
          </Card>
        ) : hotspots.data.length === 0 ? (
          <Card>
            <p style={{ margin: 0, color: 'var(--text-muted)' }}>
              No locations recorded any PCNs in {PERIOD_LABELS[period].toLowerCase()}
              {contravention ? ` for contravention code ${contravention}` : ''}. Try a wider period.
            </p>
          </Card>
        ) : (
          <HotspotList rows={hotspots.data} />
        )}
      </div>

      <div style={{ marginTop: 28 }}>
        <ScoreExplanation />
      </div>
    </div>
  );
}

function Filters({ period, code }: { period: Period; code?: string }) {
  const codes = ['01', '02', '12', '21', '23', '24', '30', '40', '45', '46', '47', '99'];
  const href = (nextPeriod: Period, nextCode?: string) => {
    const params = new URLSearchParams({ period: nextPeriod });
    if (nextCode) params.set('code', nextCode);
    return `/hotspots?${params}`;
  };

  return (
    <div className="fr-stack" style={{ marginTop: 24, gap: 14 }}>
      <div>
        <div className="fr-eyebrow" style={{ marginBottom: 7 }}>
          Period
        </div>
        <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
          {(Object.keys(PERIOD_LABELS) as Period[]).map((value) => (
            <Link
              key={value}
              href={href(value, code)}
              className="fr-touch"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                padding: '0 14px',
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--border-strong)',
                background: period === value ? 'var(--color-ink-900)' : 'transparent',
                color: period === value ? 'var(--color-ink-50)' : 'var(--text-muted)',
                fontSize: 13.5,
                textDecoration: 'none',
              }}
            >
              {PERIOD_LABELS[value]}
            </Link>
          ))}
        </div>
      </div>

      <div style={{ minWidth: 0 }}>
        <div className="fr-eyebrow" style={{ marginBottom: 7 }}>
          Contravention
        </div>
        <div className="fr-scroll-x">
          <div style={{ display: 'flex', gap: 6, paddingBottom: 4 }}>
            <Link
              href={href(period)}
              className="fr-touch"
              style={chipStyle(!code)}
            >
              All
            </Link>
            {codes.map((value) => (
              <Link key={value} href={href(period, value)} className="fr-touch" style={chipStyle(code === value)}>
                {value}
              </Link>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function chipStyle(active: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '0 13px',
    borderRadius: 'var(--radius-md)',
    border: '1px solid var(--border-strong)',
    background: active ? 'var(--color-ink-900)' : 'transparent',
    color: active ? 'var(--color-ink-50)' : 'var(--text-muted)',
    fontSize: 13.5,
    textDecoration: 'none',
    whiteSpace: 'nowrap',
  };
}

/**
 * Cards on mobile, a table from tablet up. The spec is explicit about not putting
 * tiny tables on phones, so the mobile view is a stack of cards with the same data.
 */
function HotspotList({ rows }: { rows: HotspotRow[] }) {
  return (
    <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 10 }}>
      {rows.map((row, index) => {
        const contravention = row.dominantContravention
          ? getContravention(row.dominantContravention)
          : undefined;

        return (
          <li key={row.locationId}>
            <Card>
              <div
                style={{
                  display: 'grid',
                  gap: 14,
                  gridTemplateColumns: 'auto 1fr',
                  alignItems: 'start',
                }}
              >
                <span
                  className="fr-numeric"
                  aria-label={`Rank ${index + 1}`}
                  style={{
                    fontSize: 13,
                    fontWeight: 650,
                    color: 'var(--text-faint)',
                    paddingTop: 3,
                    minWidth: 24,
                  }}
                >
                  {String(index + 1).padStart(2, '0')}
                </span>

                <div style={{ display: 'grid', gap: 12 }}>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      gap: 16,
                      flexWrap: 'wrap',
                      alignItems: 'flex-start',
                    }}
                  >
                    <div>
                      <Link
                        href={`/hotspots/${row.authoritySlug}/${row.slug}`}
                        style={{ fontSize: 17, fontWeight: 600, textDecoration: 'none', color: 'var(--text)' }}
                      >
                        {row.displayName}
                      </Link>
                      <div style={{ fontSize: 13, color: 'var(--text-faint)', marginTop: 2 }}>
                        <span className="fr-numeric">{row.totalPcns.toLocaleString('en-GB')}</span>{' '}
                        PCNs recorded
                      </div>
                    </div>

                    {row.score !== null && row.classification !== null ? (
                      <ScoreBadge score={row.score} classification={row.classification} size="sm" />
                    ) : (
                      <ScoreUnavailable
                        reason={row.refusalReason ?? 'Not enough data to rank this location.'}
                      />
                    )}
                  </div>

                  <dl
                    style={{
                      margin: 0,
                      display: 'grid',
                      gap: 12,
                      gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
                      fontSize: 13,
                    }}
                  >
                    <Field label="Dominant contravention">
                      {row.dominantContravention ? (
                        <Link href={`/codes/${row.dominantContravention}`}>
                          {row.dominantContravention}
                          {contravention ? ` · ${truncate(contravention.summary, 44)}` : ''}
                        </Link>
                      ) : (
                        <span style={{ color: 'var(--text-faint)' }}>Not recorded</span>
                      )}
                    </Field>
                    <Field label="Peak window">
                      {row.peakWindow ?? <span style={{ color: 'var(--text-faint)' }}>No times recorded</span>}
                    </Field>
                    <Field label="Trend">{trendLabel(row.trend)}</Field>
                    <Field label="Data confidence">
                      <span className="fr-numeric">{Math.round(row.dataConfidence * 100)}%</span>
                    </Field>
                  </dl>
                </div>
              </div>
            </Card>
          </li>
        );
      })}
    </ol>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="fr-eyebrow" style={{ marginBottom: 3 }}>
        {label}
      </dt>
      <dd style={{ margin: 0 }}>{children}</dd>
    </div>
  );
}

function trendLabel(trend: HotspotRow['trend']): React.ReactNode {
  const map = {
    RISING: { label: 'Rising', colour: 'var(--color-warn)' },
    FALLING: { label: 'Falling', colour: 'var(--color-ok)' },
    STABLE: { label: 'Stable', colour: 'var(--text-muted)' },
    UNKNOWN: { label: 'Not enough data', colour: 'var(--text-faint)' },
  } as const;
  const entry = map[trend];
  return <span style={{ color: entry.colour }}>{entry.label}</span>;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function parsePeriod(value: string | string[] | undefined): Period {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === '30D' || raw === '90D' || raw === '12M' ? raw : '12M';
}

function parseCode(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw && /^\d{2}$/.test(raw) ? raw : undefined;
}
