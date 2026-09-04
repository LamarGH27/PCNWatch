import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getCoverage, getLocation, type LocationDetail } from '@/server/repositories/enforcement';
import { getContravention } from '@/core/reference/store';
import { isAuthorityInMapScope } from '@/core/coverage/coverage';
import { SCORE_DISCLAIMER } from '@/core/scoring/config';
import {
  Card,
  CoverageNotice,
  DataPoint,
  ScoreBadge,
  ScoreExplanation,
  ScoreUnavailable,
  SourceAttribution,
  formatDateTime,
} from '@/components/primitives';

export const revalidate = 3600;

interface PageProps {
  params: Promise<{ authority: string; location: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { authority, location } = await params;
  if (!isAuthorityInMapScope(authority)) return { title: 'Location not covered' };

  const result = await getLocation(authority, location);
  if (!result.ok || !result.data) {
    return { title: 'Location', robots: { index: false, follow: true } };
  }

  const detail = result.data;
  const title = `${detail.displayName} — PCN enforcement activity`;
  const description =
    `Historical penalty charge notice activity recorded on ${detail.displayName}: ` +
    `${detail.totalPcns.toLocaleString('en-GB')} PCNs in the available data` +
    (detail.dominantContravention ? `, most commonly contravention ${detail.dominantContravention}` : '') +
    '. Enforcement history, not a statement about whether parking is permitted.';

  return {
    title,
    description,
    alternates: { canonical: `/hotspots/${authority}/${location}` },
    openGraph: { title, description, url: `/hotspots/${authority}/${location}` },
    // A page with too little data is not worth indexing; thin pages are exactly
    // what the spec forbids.
    robots: detail.totalPcns >= 20 ? { index: true, follow: true } : { index: false, follow: true },
  };
}

export default async function LocationPage({ params }: PageProps) {
  const { authority, location } = await params;
  if (!isAuthorityInMapScope(authority)) notFound();

  const coverage = await getCoverage(authority);
  const result = await getLocation(authority, location);

  if (!result.ok) {
    return (
      <div className="fr-container" style={{ paddingBlock: 48, maxWidth: 720 }}>
        <h1 style={{ fontSize: 26, fontWeight: 620 }}>Data temporarily unavailable</h1>
        <p style={{ marginTop: 12, color: 'var(--text-muted)' }}>
          We could not load this location just now. This is a problem on our side, not a statement
          about enforcement activity here.
        </p>
        <p style={{ marginTop: 10, fontSize: 12.5, color: 'var(--text-faint)' }}>
          Reference {result.correlationId}
        </p>
        <p style={{ marginTop: 20 }}>
          <Link href="/hotspots">← Back to hotspots</Link>
        </p>
      </div>
    );
  }

  if (!result.data) notFound();
  const detail = result.data;

  return (
    <div className="fr-container" style={{ paddingBlock: 36 }}>
      <nav aria-label="Breadcrumb" style={{ fontSize: 13, marginBottom: 14 }}>
        <Link href="/hotspots" style={{ color: 'var(--text-muted)' }}>
          Hotspots
        </Link>
        <span style={{ color: 'var(--text-faint)' }}> / </span>
        <span style={{ color: 'var(--text-faint)' }}>{detail.displayName}</span>
      </nav>

      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          gap: 24,
          flexWrap: 'wrap',
          alignItems: 'flex-start',
        }}
      >
        <div style={{ maxWidth: 620 }}>
          <h1 style={{ fontSize: 'clamp(26px, 4vw, 38px)', fontWeight: 630 }}>
            {detail.displayName}
          </h1>
          <p style={{ marginTop: 8, color: 'var(--text-muted)', fontSize: 15.5 }}>
            Penalty charge notice activity recorded in the published dataset for this location.
          </p>
        </div>
        <div>
          {detail.score !== null && detail.classification !== null ? (
            <ScoreBadge score={detail.score} classification={detail.classification} size="lg" />
          ) : (
            <ScoreUnavailable
              reason={detail.refusalReason ?? 'There is not enough data here to produce a score.'}
            />
          )}
        </div>
      </div>

      {!coverage.canShowActivity && (
        <div style={{ marginTop: 20, maxWidth: 620 }}>
          <CoverageNotice coverage={coverage} />
        </div>
      )}

      {/* Headline figures */}
      <div
        style={{
          marginTop: 28,
          display: 'grid',
          gap: 16,
          gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
        }}
      >
        <Card>
          <DataPoint
            label="Total PCNs"
            value={detail.totalPcns.toLocaleString('en-GB')}
            hint={periodHint(detail)}
          />
        </Card>
        <Card>
          <DataPoint
            label="Busiest time"
            value={detail.peakWindow ?? '—'}
            hint={detail.peakWindow ? 'Hour with the most recorded PCNs' : 'No times recorded in the source'}
          />
        </Card>
        <Card>
          <DataPoint label="Busiest day" value={busiestDay(detail.dayProfile) ?? '—'} />
        </Card>
        <Card>
          <DataPoint
            label="Data confidence"
            value={`${Math.round(detail.dataConfidence * 100)}%`}
            hint="Completeness and precision of the source records"
          />
        </Card>
      </div>

      {/* Contraventions */}
      <section style={{ marginTop: 36 }}>
        <h2 style={{ fontSize: 20, fontWeight: 620, marginBottom: 14 }}>
          Most common contraventions
        </h2>
        {detail.contraventionBreakdown.length === 0 ? (
          <Card>
            <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 14.5 }}>
              The source did not record contravention codes for these notices.
            </p>
          </Card>
        ) : (
          <Card padded={false}>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {detail.contraventionBreakdown.slice(0, 6).map((entry: { code: string; count: number }, i: number) => {
                const record = getContravention(entry.code);
                const share = detail.totalPcns > 0 ? entry.count / detail.totalPcns : 0;
                return (
                  <li
                    key={entry.code}
                    style={{
                      padding: '14px 18px',
                      borderTop: i === 0 ? 'none' : '1px solid var(--border)',
                      display: 'grid',
                      gap: 8,
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        gap: 14,
                        alignItems: 'baseline',
                      }}
                    >
                      <Link href={`/codes/${entry.code}`} style={{ fontWeight: 600, fontSize: 15 }}>
                        Code {entry.code}
                      </Link>
                      <span className="fr-numeric" style={{ fontSize: 14, color: 'var(--text-muted)' }}>
                        {entry.count.toLocaleString('en-GB')} · {Math.round(share * 100)}%
                      </span>
                    </div>
                    <div
                      aria-hidden="true"
                      style={{ height: 4, background: 'var(--surface-sunken)', borderRadius: 2 }}
                    >
                      <div
                        style={{
                          width: `${Math.max(2, share * 100)}%`,
                          height: '100%',
                          background: 'var(--color-signal-500)',
                          borderRadius: 2,
                        }}
                      />
                    </div>
                    {record && (
                      <p style={{ margin: 0, fontSize: 13.5, color: 'var(--text-muted)' }}>
                        {record.summary}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          </Card>
        )}
      </section>

      {/* Temporal profile */}
      {detail.hourProfile.length > 0 && (
        <section style={{ marginTop: 36 }}>
          <h2 style={{ fontSize: 20, fontWeight: 620, marginBottom: 14 }}>When notices are issued</h2>
          <Card>
            <HourChart profile={detail.hourProfile} />
          </Card>
        </section>
      )}

      {/* Provenance */}
      <section style={{ marginTop: 36 }}>
        <h2 style={{ fontSize: 20, fontWeight: 620, marginBottom: 14 }}>Where this comes from</h2>
        <Card>
          <SourceAttribution
            sourceName={detail.sourceName ?? 'Unknown source'}
            attribution={detail.sourceAttribution ?? 'Attribution unavailable.'}
            retrievedAt={detail.retrievedAt}
            sourceUrl={detail.sourceUrl}
          />
          <div style={{ marginTop: 14 }}>
            <ScoreExplanation />
          </div>
        </Card>
      </section>

      {/* CTA */}
      <div
        style={{
          marginTop: 36,
          padding: 24,
          border: '1px solid var(--border-strong)',
          borderRadius: 'var(--radius-lg)',
          background: 'var(--surface-sunken)',
        }}
      >
        <h2 style={{ fontSize: 19, fontWeight: 620, marginBottom: 8 }}>Got a PCN here?</h2>
        <p style={{ margin: '0 0 16px', color: 'var(--text-muted)', fontSize: 15, maxWidth: 560 }}>
          Upload the notice and we will decode it, work out your deadlines and tell you what
          evidence matters for this contravention.
        </p>
        <Link
          href="/analyse"
          className="fr-touch"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            padding: '0 20px',
            background: 'var(--color-ink-900)',
            color: 'var(--color-ink-50)',
            borderRadius: 'var(--radius-md)',
            fontWeight: 550,
            fontSize: 15,
            textDecoration: 'none',
          }}
        >
          Analyse it
        </Link>
      </div>

      <p style={{ marginTop: 28, fontSize: 12.5, color: 'var(--text-faint)', maxWidth: 640 }}>
        {SCORE_DISCLAIMER}
      </p>
    </div>
  );
}

function HourChart({ profile }: { profile: readonly number[] }) {
  const counts = Array.from({ length: 24 }, (_, h) => Number(profile[h] ?? 0));
  const max = Math.max(...counts, 1);

  return (
    <div>
      <div
        role="img"
        aria-label={`Hourly distribution of recorded PCNs. Peak at ${counts.indexOf(max)}:00.`}
        style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 108 }}
      >
        {counts.map((count, hour) => (
          <div
            key={hour}
            title={`${String(hour).padStart(2, '0')}:00 — ${count} PCNs`}
            style={{
              flex: 1,
              height: `${Math.max(2, (count / max) * 100)}%`,
              background:
                count === max ? 'var(--color-activity-4)' : 'var(--color-signal-400)',
              borderRadius: '2px 2px 0 0',
              minWidth: 4,
            }}
          />
        ))}
      </div>
      <div
        aria-hidden="true"
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          marginTop: 6,
          fontSize: 11,
          color: 'var(--text-faint)',
        }}
      >
        <span>00:00</span>
        <span>06:00</span>
        <span>12:00</span>
        <span>18:00</span>
        <span>23:00</span>
      </div>
      <p style={{ margin: '10px 0 0', fontSize: 12.5, color: 'var(--text-faint)' }}>
        Only notices where the source recorded a time are included.
      </p>
    </div>
  );
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function busiestDay(profile: readonly number[]): string | null {
  const counts = Array.from({ length: 7 }, (_, d) => Number(profile[d] ?? 0));
  const max = Math.max(...counts);
  if (max === 0) return null;
  return DAY_NAMES[counts.indexOf(max)] ?? null;
}

function periodHint(detail: LocationDetail): string {
  if (!detail.periodStart || !detail.periodEnd) return 'Period not recorded';
  return `${formatDateTime(detail.periodStart)} – ${formatDateTime(detail.periodEnd)}`;
}
