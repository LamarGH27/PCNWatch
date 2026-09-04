import type { CSSProperties, ReactNode } from 'react';
import { CLASSIFICATION_BANDS, SCORE_DISCLAIMER } from '@/core/scoring/config';
import type { ScoreClassification } from '@/core/scoring/types';
import type { CoverageResult } from '@/core/coverage/coverage';

/* ------------------------------------------------------------------ */
/* Activity score                                                      */
/* ------------------------------------------------------------------ */

const ACTIVITY_COLOURS: Record<ScoreClassification, string> = {
  VERY_LOW: 'var(--color-activity-1)',
  LOW: 'var(--color-activity-2)',
  MODERATE: 'var(--color-activity-3)',
  HIGH: 'var(--color-activity-4)',
  VERY_HIGH: 'var(--color-activity-5)',
};

export function activityColour(classification: ScoreClassification): string {
  return ACTIVITY_COLOURS[classification];
}

export function classificationLabel(classification: ScoreClassification): string {
  return CLASSIFICATION_BANDS.find((b) => b.key === classification)?.label ?? 'Unknown';
}

/**
 * The score readout.
 *
 * The explanation is attached to the score itself rather than hidden in a footnote,
 * because the single biggest risk with this number is a user reading it as
 * "chance of getting a ticket".
 */
export function ScoreBadge({
  score,
  classification,
  size = 'md',
}: {
  score: number;
  classification: ScoreClassification;
  size?: 'sm' | 'md' | 'lg';
}) {
  const dimensions = { sm: 38, md: 52, lg: 76 }[size];
  const fontSize = { sm: 15, md: 20, lg: 30 }[size];

  return (
    <span
      style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}
      title={SCORE_DISCLAIMER}
    >
      <span
        className="fr-numeric"
        aria-hidden="true"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: dimensions,
          height: dimensions,
          borderRadius: 'var(--radius-md)',
          background: activityColour(classification),
          color: '#fff',
          fontSize,
          fontWeight: 600,
          lineHeight: 1,
        }}
      >
        {score}
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.25 }}>
        <span style={{ fontSize: size === 'lg' ? 15 : 13, fontWeight: 550 }}>
          {classificationLabel(classification)}
        </span>
        <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>
          Ticket Activity Score {score}/100
        </span>
      </span>
    </span>
  );
}

/** The approved wording. Rendered verbatim wherever a score appears. */
export function ScoreExplanation({ compact = false }: { compact?: boolean }) {
  return (
    <p
      style={{
        margin: 0,
        fontSize: compact ? 12 : 13,
        color: 'var(--text-muted)',
        maxWidth: 620,
      }}
    >
      {SCORE_DISCLAIMER}
    </p>
  );
}

/** Shown when a location could not be scored. States why, never a fallback number. */
export function ScoreUnavailable({ reason }: { reason: string }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 12px',
        border: '1px dashed var(--border-strong)',
        borderRadius: 'var(--radius-md)',
        fontSize: 13,
        color: 'var(--text-muted)',
      }}
    >
      <span aria-hidden="true" style={{ color: 'var(--text-faint)' }}>
        —
      </span>
      <span>
        <strong style={{ fontWeight: 550, color: 'var(--text)' }}>No score</strong> · {reason}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Coverage                                                            */
/* ------------------------------------------------------------------ */

const COVERAGE_TONE: Record<CoverageResult['state'], { border: string; bg: string }> = {
  COVERED: { border: 'var(--color-ok)', bg: 'color-mix(in srgb, var(--color-ok) 8%, transparent)' },
  NO_COVERAGE: { border: 'var(--border-strong)', bg: 'var(--surface-sunken)' },
  TEMPORARILY_UNAVAILABLE: {
    border: 'var(--color-warn)',
    bg: 'color-mix(in srgb, var(--color-warn) 10%, transparent)',
  },
  DEMO_DATA: {
    border: 'var(--color-urgent)',
    bg: 'color-mix(in srgb, var(--color-urgent) 12%, transparent)',
  },
};

export function CoverageNotice({ coverage }: { coverage: CoverageResult }) {
  const tone = COVERAGE_TONE[coverage.state];
  return (
    <div
      role={coverage.state === 'COVERED' ? undefined : 'status'}
      style={{
        border: `1px solid ${tone.border}`,
        background: tone.bg,
        borderRadius: 'var(--radius-md)',
        padding: '12px 14px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        {coverage.state === 'DEMO_DATA' && (
          <span
            style={{
              fontSize: 10.5,
              fontWeight: 700,
              letterSpacing: '0.1em',
              padding: '2px 6px',
              borderRadius: 3,
              background: 'var(--color-urgent)',
              color: '#fff',
            }}
          >
            DEMO
          </span>
        )}
        <strong style={{ fontSize: 14, fontWeight: 600 }}>{coverage.headline}</strong>
      </div>
      <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--text-muted)' }}>{coverage.detail}</p>
      {coverage.lastUpdated && coverage.state === 'COVERED' && (
        <p style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--text-faint)' }}>
          Data last refreshed {formatDateTime(coverage.lastUpdated)} ·{' '}
          <span className="fr-numeric">{coverage.eventCount.toLocaleString('en-GB')}</span> PCN
          records
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Layout helpers                                                      */
/* ------------------------------------------------------------------ */

export function Section({
  eyebrow,
  title,
  intro,
  children,
  style,
}: {
  eyebrow?: string;
  title?: string;
  intro?: ReactNode;
  children?: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <section style={{ paddingBlock: 64, ...style }}>
      <div className="fr-container">
        {eyebrow && (
          <div className="fr-eyebrow" style={{ marginBottom: 12 }}>
            {eyebrow}
          </div>
        )}
        {title && (
          <h2 style={{ fontSize: 'clamp(24px, 3.2vw, 34px)', fontWeight: 620, maxWidth: 720 }}>
            {title}
          </h2>
        )}
        {intro && (
          <div style={{ marginTop: 14, maxWidth: 660, color: 'var(--text-muted)', fontSize: 16 }}>
            {intro}
          </div>
        )}
        {children && <div style={{ marginTop: title || intro ? 36 : 0 }}>{children}</div>}
      </div>
    </section>
  );
}

export function Card({
  children,
  padded = true,
  style,
}: {
  children: ReactNode;
  padded?: boolean;
  style?: CSSProperties;
}) {
  return (
    <div className="fr-panel" style={{ padding: padded ? 20 : 0, ...style }}>
      {children}
    </div>
  );
}

export function DataPoint({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
}) {
  return (
    <div>
      <div className="fr-eyebrow" style={{ marginBottom: 5 }}>
        {label}
      </div>
      <div className="fr-numeric" style={{ fontSize: 20, fontWeight: 600, lineHeight: 1.2 }}>
        {value}
      </div>
      {hint && (
        <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 3 }}>{hint}</div>
      )}
    </div>
  );
}

/** Source attribution. Rendered next to any figure that came from a dataset. */
export function SourceAttribution({
  sourceName,
  attribution,
  retrievedAt,
  sourceUrl,
}: {
  sourceName: string;
  attribution: string;
  retrievedAt: string | null;
  sourceUrl?: string | null;
}) {
  return (
    <div style={{ fontSize: 12, color: 'var(--text-faint)', lineHeight: 1.5 }}>
      <div>
        Source:{' '}
        {sourceUrl ? (
          <a href={sourceUrl} rel="noopener noreferrer" target="_blank">
            {sourceName}
          </a>
        ) : (
          sourceName
        )}
        {retrievedAt && <> · retrieved {formatDateTime(retrievedAt)}</>}
      </div>
      <div>{attribution}</div>
    </div>
  );
}

export function Disclaimer({ children }: { children?: ReactNode }) {
  return (
    <p
      style={{
        fontSize: 13,
        color: 'var(--text-muted)',
        borderLeft: '2px solid var(--border-strong)',
        paddingLeft: 12,
        margin: 0,
        maxWidth: 640,
      }}
    >
      {children ??
        'PCNWatch provides information and document-preparation tools. It does not provide legal advice and does not guarantee that a challenge will succeed.'}
    </p>
  );
}

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

const DATE_TIME = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'Europe/London',
});

export function formatDateTime(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? 'an unknown date' : DATE_TIME.format(parsed);
}

export function formatPence(pence: number): string {
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(pence / 100);
}
