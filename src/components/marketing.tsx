import Link from 'next/link';
import type { CSSProperties, ReactNode } from 'react';

/**
 * The marketing vocabulary.
 *
 * Five components, reused everywhere, rather than a bespoke class string per
 * section. The point is not brevity — it is that a change to how a feature card
 * looks happens once, and that two sections cannot quietly drift into two
 * different design languages.
 *
 * Everything visual lives in `globals.css` as a class. These components decide
 * structure and semantics; they do not carry colours.
 */

export type Accent = 'brand' | 'cyan' | 'violet' | 'amber';

/** Tints for the icon tiles and pills. Four, and no component invents a fifth. */
export const ACCENTS: Record<Accent, { bg: string; border: string; fg: string }> = {
  brand: { bg: 'rgb(47 123 255 / 0.14)', border: 'rgb(47 123 255 / 0.3)', fg: 'var(--color-brand-400)' },
  cyan: { bg: 'rgb(23 188 212 / 0.14)', border: 'rgb(23 188 212 / 0.3)', fg: 'var(--color-cyan-400)' },
  violet: { bg: 'rgb(134 89 240 / 0.16)', border: 'rgb(134 89 240 / 0.32)', fg: 'var(--color-violet-400)' },
  amber: { bg: 'rgb(232 180 69 / 0.14)', border: 'rgb(232 180 69 / 0.3)', fg: 'var(--color-activity-3)' },
};

function accentVars(accent: Accent): CSSProperties {
  const tint = ACCENTS[accent];
  return {
    ['--tile-bg' as string]: tint.bg,
    ['--tile-border' as string]: tint.border,
    ['--tile-fg' as string]: tint.fg,
  };
}

/* ------------------------------------------------------------------ */

export function Section({
  id,
  eyebrow,
  title,
  lede,
  action,
  children,
  tone = 'default',
}: {
  id?: string;
  eyebrow?: string;
  title?: string;
  lede?: ReactNode;
  /** Sits opposite the heading on desktop, under it on a phone. */
  action?: ReactNode;
  children: ReactNode;
  /** `sunken` separates two adjacent sections without adding a rule. */
  tone?: 'default' | 'sunken';
}) {
  return (
    <section
      id={id}
      className="fr-section"
      style={tone === 'sunken' ? { background: 'rgb(255 255 255 / 0.02)' } : undefined}
    >
      <div className="fr-container fr-stack">
        {(eyebrow || title || lede || action) && (
          <div
            className="fr-rise"
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'flex-end',
              justifyContent: 'space-between',
              gap: 20,
              marginBottom: 'clamp(28px, 4vw, 44px)',
            }}
          >
            <div style={{ maxWidth: 640 }}>
              {eyebrow && <div className="fr-eyebrow">{eyebrow}</div>}
              {title && <h2 className="fr-h2" style={{ marginTop: eyebrow ? 12 : 0 }}>{title}</h2>}
              {lede && <p className="fr-lede" style={{ marginTop: 14 }}>{lede}</p>}
            </div>
            {action}
          </div>
        )}
        {children}
      </div>
    </section>
  );
}

/** A responsive grid that never forces a card narrower than it can read at. */
export function CardGrid({ min = 260, children }: { min?: number; children: ReactNode }) {
  return (
    <div
      style={{
        display: 'grid',
        gap: 18,
        gridTemplateColumns: `repeat(auto-fit, minmax(min(${min}px, 100%), 1fr))`,
      }}
    >
      {children}
    </div>
  );
}

export function GlassCard({
  children,
  accent,
  interactive = false,
  style,
}: {
  children: ReactNode;
  accent?: Accent;
  interactive?: boolean;
  style?: CSSProperties;
}) {
  return (
    <div
      className={`fr-glass fr-rise${interactive ? ' fr-lift' : ''}`}
      style={{ padding: 22, height: '100%', ...(accent ? accentVars(accent) : {}), ...style }}
    >
      {children}
    </div>
  );
}

/**
 * A feature that links somewhere. The whole card lifts, but only the heading is
 * the link — a card-wide anchor swallows text selection and reads as one
 * enormous link to a screen reader.
 */
export function FeatureCard({
  icon,
  title,
  body,
  href,
  linkLabel,
  accent = 'brand',
}: {
  icon: ReactNode;
  title: string;
  body: string;
  href: string;
  linkLabel: string;
  accent?: Accent;
}) {
  return (
    <GlassCard accent={accent} interactive>
      <div className="fr-icon-tile" aria-hidden="true">
        {icon}
      </div>
      <h3 style={{ fontSize: 17.5, fontWeight: 640, marginTop: 16, letterSpacing: '-0.01em' }}>
        <Link href={href} style={{ color: 'inherit', textDecoration: 'none' }}>
          {title}
        </Link>
      </h3>
      <p style={{ margin: '8px 0 0', fontSize: 14.5, color: 'var(--text-muted)', lineHeight: 1.55 }}>
        {body}
      </p>
      <span
        aria-hidden="true"
        style={{
          display: 'inline-block',
          marginTop: 14,
          fontSize: 14,
          fontWeight: 600,
          color: 'var(--color-brand-400)',
        }}
      >
        {linkLabel} →
      </span>
    </GlassCard>
  );
}

/** One numbered step in the "how it works" sequence. */
export function StepCard({
  step,
  title,
  body,
  accent = 'brand',
  children,
}: {
  step: number;
  title: string;
  body: string;
  accent?: Accent;
  /** An optional product-UI fragment shown under the copy. */
  children?: ReactNode;
}) {
  return (
    <GlassCard accent={accent} style={{ display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span
          className="fr-icon-tile fr-numeric"
          aria-hidden="true"
          style={{ width: 34, height: 34, borderRadius: 10, fontSize: 15, fontWeight: 700 }}
        >
          {step}
        </span>
        <h3 style={{ fontSize: 17, fontWeight: 640, letterSpacing: '-0.01em' }}>{title}</h3>
      </div>
      <p style={{ margin: '12px 0 0', fontSize: 14.5, color: 'var(--text-muted)', lineHeight: 1.55 }}>
        {body}
      </p>
      {children && <div style={{ marginTop: 18 }}>{children}</div>}
    </GlassCard>
  );
}

export function CtaLink({
  href,
  children,
  variant = 'primary',
  icon,
}: {
  href: string;
  children: ReactNode;
  variant?: 'primary' | 'secondary';
  icon?: ReactNode;
}) {
  return (
    <Link href={href} className={`fr-touch fr-btn fr-btn-${variant}`}>
      {icon}
      {children}
    </Link>
  );
}

export function Pill({
  children,
  accent = 'brand',
}: {
  children: ReactNode;
  accent?: Accent | 'muted';
}) {
  const tint = accent === 'muted' ? null : ACCENTS[accent];
  return (
    <span
      className="fr-pill"
      style={
        tint
          ? {
              ['--pill-bg' as string]: tint.bg,
              ['--pill-border' as string]: tint.border,
              ['--pill-fg' as string]: tint.fg,
            }
          : undefined
      }
    >
      {children}
    </span>
  );
}
