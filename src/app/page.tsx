import type { Metadata } from 'next';
import Link from 'next/link';
import { COVERAGE_SCOPE } from '@/core/coverage/coverage';
import { LONDON_AUTHORITIES } from '@/server/repositories/authorities-data';
import { PRODUCTS } from '@/server/payments/catalogue';
import { SCORE_DISCLAIMER } from '@/core/scoring/config';
import { Disclaimer, formatPence } from '@/components/primitives';
import {
  CardGrid,
  CtaLink,
  FeatureCard,
  GlassCard,
  Pill,
  Section,
  StepCard,
} from '@/components/marketing';
import { HeroGraphic } from '@/components/HeroGraphic';
import {
  BookIcon,
  CalendarIcon,
  CardIcon,
  ChecklistIcon,
  DocumentIcon,
  LockIcon,
  MapPinIcon,
  ScaleIcon,
  ScanIcon,
  ShieldIcon,
  SparkIcon,
} from '@/components/icons';

export const metadata: Metadata = {
  title: 'PCNWatch — fight unfair parking tickets with clarity',
  description:
    'Scan your penalty charge notice, understand what it means in plain English, and build a stronger response with clear guidance and an evidence checklist.',
  alternates: { canonical: '/' },
  openGraph: {
    title: 'PCNWatch — fight unfair parking tickets with clarity',
    description:
      'Scan your PCN, understand what it means, and build a stronger response with clear guidance and smarter evidence.',
    url: '/',
  },
};

export default function LandingPage() {
  return (
    <>
      <Hero />
      <ValueStrip />
      <HowItWorks />
      <Features />
      <Coverage />
      <Credibility />
      <Pricing />
      <Faqs />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Hero                                                                */
/* ------------------------------------------------------------------ */

function Hero() {
  return (
    <section
      style={{
        position: 'relative',
        overflow: 'hidden',
        borderBottom: '1px solid var(--border)',
        paddingBlock: 'clamp(44px, 7vw, 88px)',
      }}
    >
      <div className="fr-container fr-stack">
        {/*
          One column until there is genuinely room for two.

          The column rule lives in the stylesheet rather than here: an inline
          `gridTemplateColumns` outranks a media query, so setting it here left
          the hero stuck in one column at every width and the illustration
          stretched across the full page under the headline.
        */}
        <div className="fr-hero-grid">
          <div style={{ maxWidth: 620 }}>
            <div className="fr-eyebrow fr-rise">AI-assisted parking support</div>

            <h1
              className="fr-rise"
              style={{
                marginTop: 16,
                fontSize: 'clamp(36px, 6.2vw, 64px)',
                fontWeight: 700,
                letterSpacing: '-0.035em',
                lineHeight: 1.04,
              }}
            >
              Fight unfair parking tickets with{' '}
              <span
                style={{
                  background:
                    'linear-gradient(100deg, var(--color-brand-400), var(--color-cyan-400))',
                  WebkitBackgroundClip: 'text',
                  backgroundClip: 'text',
                  color: 'transparent',
                }}
              >
                clarity
              </span>
              .
            </h1>

            <p className="fr-lede fr-rise" style={{ marginTop: 20 }}>
              Scan your PCN, understand what it means, and build a stronger response with clear
              guidance and smarter evidence.
            </p>

            <div
              className="fr-rise"
              style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 30 }}
            >
              <CtaLink href="/analyse" icon={<ScanIcon size={18} />}>
                Scan your PCN
              </CtaLink>
              <CtaLink href="#how-it-works" variant="secondary">
                See how it works
              </CtaLink>
            </div>

            {/*
              Three claims, each of which is true today.
              Deliberately not "UK-wide coverage": the enforcement map is one
              borough, and a badge saying otherwise would be the first thing on
              the page that could not be defended.
            */}
            <ul
              className="fr-rise"
              style={{
                listStyle: 'none',
                display: 'flex',
                flexWrap: 'wrap',
                gap: '10px 20px',
                margin: '28px 0 0',
                padding: 0,
                fontSize: 13.5,
                color: 'var(--text-muted)',
              }}
            >
              {[
                'Plain-English explanations',
                'Your case stays private',
                'No card details stored',
              ].map((claim) => (
                <li key={claim} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                  <span style={{ color: 'var(--color-cyan-400)', display: 'flex' }} aria-hidden="true">
                    <ShieldIcon size={15} />
                  </span>
                  {claim}
                </li>
              ))}
            </ul>
          </div>

          <div className="fr-hero-art" style={{ minWidth: 0 }}>
            <HeroGraphic />
          </div>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Value strip                                                         */
/* ------------------------------------------------------------------ */

const JOURNEY = [
  {
    icon: <ScanIcon />,
    title: 'Scan a notice',
    body: 'Photograph your PCN and we read the details off it.',
    accent: 'brand' as const,
  },
  {
    icon: <BookIcon />,
    title: 'Understand the contravention',
    body: 'What the code on your notice actually alleges, in plain English.',
    accent: 'cyan' as const,
  },
  {
    /*
     * Not "never miss a deadline", and not "we calculate your dates".
     *
     * The timing rules behind a calculated deadline are still
     * PENDING_LEGAL_REVIEW, and the product deliberately withholds any date it
     * would have had to work out itself. Marketing a calculation the product
     * refuses to perform would be the worst kind of inaccuracy: the one the
     * user only discovers after they have relied on it.
     */
    icon: <CalendarIcon />,
    title: 'Keep the dates together',
    body: 'The deadlines printed on your notice, in one place. We never invent a date we cannot stand behind.',
    accent: 'violet' as const,
  },
  {
    icon: <DocumentIcon />,
    title: 'Build your challenge',
    body: 'A factual challenge letter and an evidence checklist you can act on.',
    accent: 'brand' as const,
  },
];

function ValueStrip() {
  return (
    <section
      style={{
        borderBottom: '1px solid var(--border)',
        background: 'rgb(255 255 255 / 0.02)',
        paddingBlock: 'clamp(28px, 4vw, 40px)',
      }}
    >
      <div className="fr-container fr-stack">
        <ol
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'grid',
            gap: 18,
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(230px, 100%), 1fr))',
          }}
        >
          {JOURNEY.map((step, index) => (
            <li
              key={step.title}
              className="fr-rise"
              style={{
                display: 'flex',
                gap: 14,
                alignItems: 'flex-start',
                position: 'relative',
                paddingRight: index < JOURNEY.length - 1 ? 18 : 0,
              }}
            >
              <span
                className="fr-icon-tile"
                aria-hidden="true"
                style={{
                  ['--tile-bg' as string]:
                    step.accent === 'cyan'
                      ? 'rgb(23 188 212 / 0.14)'
                      : step.accent === 'violet'
                        ? 'rgb(134 89 240 / 0.16)'
                        : 'rgb(47 123 255 / 0.14)',
                  ['--tile-fg' as string]:
                    step.accent === 'cyan'
                      ? 'var(--color-cyan-400)'
                      : step.accent === 'violet'
                        ? 'var(--color-violet-400)'
                        : 'var(--color-brand-400)',
                }}
              >
                {step.icon}
              </span>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 620, letterSpacing: '-0.01em' }}>
                  {step.title}
                </div>
                <p style={{ margin: '4px 0 0', fontSize: 13.5, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                  {step.body}
                </p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* How it works                                                        */
/* ------------------------------------------------------------------ */

function HowItWorks() {
  return (
    <Section
      id="how-it-works"
      eyebrow="Simple. Smart. Supportive."
      title="How PCNWatch works"
      lede="Three steps, and most people are through them in a couple of minutes. We ask for what your case actually turns on and nothing else."
    >
      <CardGrid min={300}>
        <StepCard
          step={1}
          title="Upload or scan your PCN"
          body="Take a photo of your notice, or upload one. We read the notice number, the contravention code, the date, the location and the amount so you do not have to type them."
          accent="brand"
        >
          <MiniExtract />
        </StepCard>

        <StepCard
          step={2}
          title="Check what we found"
          body="You confirm what we read in one tap where it was clear, and correct anything it was not. Nothing we could not read confidently is used until you have checked it."
          accent="cyan"
        >
          <MiniVerify />
        </StepCard>

        <StepCard
          step={3}
          title="Get guidance and build your challenge"
          body="Tell us what happened in your own words. We ask at most three follow-up questions, then give you an assessment, an evidence checklist and a challenge you can send."
          accent="violet"
        >
          <MiniOutcome />
        </StepCard>
      </CardGrid>
    </Section>
  );
}

/** Product-UI fragments. Static, illustrative, and honest about what they show. */
function MiniExtract() {
  return (
    <div
      className="fr-glass"
      style={{ padding: 14, background: 'rgb(0 0 0 / 0.28)', borderRadius: 12 }}
    >
      {[
        ['Contravention', '12'],
        ['Location', 'Gloucester Place'],
        ['Date', '4 January 2026'],
      ].map(([label, value]) => (
        <div
          key={label}
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            gap: 12,
            fontSize: 13,
            paddingBlock: 4,
          }}
        >
          <span style={{ color: 'var(--text-faint)' }}>{label}</span>
          <span className="fr-numeric" style={{ fontWeight: 600 }}>
            {value}
          </span>
        </div>
      ))}
    </div>
  );
}

function MiniVerify() {
  return (
    <div
      className="fr-glass"
      style={{ padding: 14, background: 'rgb(0 0 0 / 0.28)', borderRadius: 12 }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 13 }}>
        <span style={{ color: 'var(--color-cyan-400)', display: 'flex' }} aria-hidden="true">
          <ChecklistIcon size={17} />
        </span>
        <span style={{ fontWeight: 600 }}>Five details read clearly</span>
      </div>
      <p style={{ margin: '8px 0 0', fontSize: 12.5, color: 'var(--text-muted)' }}>
        One tap confirms them. Anything unreadable is asked about separately.
      </p>
    </div>
  );
}

function MiniOutcome() {
  return (
    <div
      className="fr-glass"
      style={{ padding: 14, background: 'rgb(0 0 0 / 0.28)', borderRadius: 12 }}
    >
      {['Evidence checklist', 'Challenge letter', 'What could weaken it'].map((line) => (
        <div
          key={line}
          style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 12.8, paddingBlock: 3 }}
        >
          <span style={{ color: 'var(--color-violet-400)', display: 'flex' }} aria-hidden="true">
            <SparkIcon size={14} />
          </span>
          {line}
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Features                                                            */
/* ------------------------------------------------------------------ */

function Features() {
  return (
    <Section
      eyebrow="Everything you need"
      title="Tools for drivers who want to understand the ticket"
      lede="Four things the product does today. Nothing here is a roadmap item."
      tone="sunken"
      action={
        <Link href="/analyse" style={{ fontSize: 15, fontWeight: 600, color: 'var(--color-brand-400)' }}>
          Analyse a notice →
        </Link>
      }
    >
      <CardGrid min={250}>
        <FeatureCard
          icon={<MapPinIcon />}
          accent="amber"
          title="Live borough hotspots"
          body="Where penalties have historically been issued, from published local-authority data. Enforcement history, not a prediction."
          href="/hotspots"
          linkLabel="View hotspots"
        />
        <FeatureCard
          icon={<BookIcon />}
          accent="cyan"
          title="PCN code library"
          body="Plain-English explanations of the contravention codes London authorities issue notices under."
          href="/codes"
          linkLabel="Browse codes"
        />
        <FeatureCard
          icon={<ChecklistIcon />}
          accent="brand"
          title="Evidence checklist"
          body="What would actually strengthen your case, ranked for your contravention — and what you already hold."
          href="/analyse"
          linkLabel="Get the checklist"
        />
        <FeatureCard
          icon={<DocumentIcon />}
          accent="violet"
          title="Defence Pack"
          body="Your case assembled into something you can send: factual points, weaknesses, checklist and an editable challenge letter."
          href="/analyse"
          linkLabel="Build your defence"
        />
      </CardGrid>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* Coverage                                                            */
/* ------------------------------------------------------------------ */

function Coverage() {
  const live = LONDON_AUTHORITIES.filter((a) => a.mapCoverage === 'LIVE');
  const planned = LONDON_AUTHORITIES.filter((a) => a.mapCoverage === 'PLANNED');
  const rest = LONDON_AUTHORITIES.length - live.length - planned.length;

  return (
    <Section
      eyebrow="Covering London — and beyond"
      title="From Camden to every borough and beyond."
      lede={
        <>
          The enforcement map is live for Camden. {COVERAGE_SCOPE.explanation} More boroughs are
          added as their data becomes available.
        </>
      }
    >
      <div
        style={{
          display: 'grid',
          gap: 20,
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(300px, 100%), 1fr))',
          alignItems: 'start',
        }}
      >
        <GlassCard>
          <div className="fr-eyebrow">Map coverage</div>
          <ul style={{ listStyle: 'none', margin: '16px 0 0', padding: 0, display: 'grid', gap: 12 }}>
            <CoverageRow
              state="Live now"
              accent="cyan"
              names={live.map((a) => a.name)}
              note="Enforcement data published and ingested."
            />
            {/*
              Rendered even when empty, and it says so.
              A blank row would read as "some boroughs are coming", which is
              not true today: no authority is marked PLANNED, so the honest
              answer is that nothing is queued behind Camden yet.
            */}
            <CoverageRow
              state="Coming soon"
              accent="brand"
              names={planned.length > 0 ? planned.map((a) => a.name) : ['None queued yet']}
              note="Identified for ingestion, ahead of being live."
            />
            <CoverageRow
              state="Planned"
              accent="muted"
              names={[`${rest} further London authorities`]}
              note="No published dataset ingested yet."
            />
          </ul>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 22 }}>
            <CtaLink href="/boroughs" variant="secondary">
              See all boroughs
            </CtaLink>
            <Link
              href="/map"
              className="fr-touch"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                fontSize: 15,
                fontWeight: 600,
                color: 'var(--color-brand-400)',
              }}
            >
              Explore the map →
            </Link>
          </div>
        </GlassCard>

        <GlassCard accent="brand">
          <div className="fr-eyebrow">Everywhere else</div>
          <h3 style={{ fontSize: 19, fontWeight: 650, marginTop: 12, letterSpacing: '-0.015em' }}>
            Analysis is not limited to the map.
          </h3>
          <p style={{ margin: '10px 0 0', fontSize: 14.5, color: 'var(--text-muted)', lineHeight: 1.55 }}>
            Scanning a notice, explaining the contravention, the evidence checklist and the
            challenge letter all work for London local-authority notices generally — not only where
            we hold map data. The map needs a published dataset per borough; your notice does not.
          </p>
          <p style={{ margin: '14px 0 0', fontSize: 13, color: 'var(--text-faint)' }}>
            {SCORE_DISCLAIMER}
          </p>
        </GlassCard>
      </div>
    </Section>
  );
}

function CoverageRow({
  state,
  names,
  note,
  accent,
}: {
  state: string;
  names: readonly string[];
  note: string;
  accent: 'cyan' | 'brand' | 'muted';
}) {
  return (
    <li style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
      <span style={{ flexShrink: 0, minWidth: 104 }}>
        <Pill accent={accent === 'muted' ? 'muted' : accent}>{state}</Pill>
      </span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 14.5, fontWeight: 570 }}>{names.join(', ')}</div>
        <div style={{ fontSize: 12.5, color: 'var(--text-faint)', marginTop: 2 }}>{note}</div>
      </div>
    </li>
  );
}

/* ------------------------------------------------------------------ */
/* Credibility                                                         */
/* ------------------------------------------------------------------ */

/*
 * Not testimonials.
 *
 * There are no real customers to quote yet, and inventing three smiling names
 * would undermine the one thing this product is actually selling — that it does
 * not make things up. So the trust section is a set of claims about how the
 * product behaves, every one of which is enforced somewhere in the codebase and
 * could be demonstrated on request.
 */
const CREDIBILITY = [
  {
    icon: <LockIcon />,
    accent: 'cyan' as const,
    title: 'Your case stays private',
    body: 'Cases are readable only by the browser that created them, enforced by row-level security in the database rather than by application code.',
  },
  {
    icon: <ChecklistIcon />,
    accent: 'brand' as const,
    title: 'Evidence-first reasoning',
    body: 'The assessment runs on facts you confirmed and documents we have actually read. Something you have told us about but not shown us does not count as evidence.',
  },
  {
    icon: <ScaleIcon />,
    accent: 'violet' as const,
    title: 'No fabricated law',
    body: 'A challenge letter cites only reference material a person has reviewed against its source. Where nothing has been reviewed, the letter argues facts and says so.',
  },
  {
    icon: <DocumentIcon />,
    accent: 'brand' as const,
    title: 'Factual challenge drafting',
    body: 'Letters are written in your name, from your account of what happened, with what could weaken the case stated rather than hidden.',
  },
  {
    icon: <CardIcon />,
    accent: 'cyan' as const,
    title: 'Payments handled by Stripe',
    body: 'Card details are entered on Stripe and never reach PCNWatch. We store the payment reference, not your card.',
  },
  {
    icon: <ShieldIcon />,
    accent: 'violet' as const,
    title: 'Honest about the gaps',
    body: 'Where we do not hold data, or a rule has not been reviewed, the product says so instead of estimating. Coverage claims match what is actually ingested.',
  },
];

function Credibility() {
  return (
    <Section
      eyebrow="Why you can trust it"
      title="Built to be checkable, not just confident."
      lede="PCNWatch is new and has no customer stories to show you yet. Rather than invent some, here is exactly how the product behaves."
      tone="sunken"
    >
      <CardGrid min={280}>
        {CREDIBILITY.map((item) => (
          <GlassCard key={item.title} accent={item.accent}>
            <div className="fr-icon-tile" aria-hidden="true">
              {item.icon}
            </div>
            <h3 style={{ fontSize: 16.5, fontWeight: 640, marginTop: 15, letterSpacing: '-0.01em' }}>
              {item.title}
            </h3>
            <p style={{ margin: '8px 0 0', fontSize: 14, color: 'var(--text-muted)', lineHeight: 1.55 }}>
              {item.body}
            </p>
          </GlassCard>
        ))}
      </CardGrid>

      <div style={{ marginTop: 28 }}>
        <Disclaimer />
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* Pricing                                                             */
/* ------------------------------------------------------------------ */

function Pricing() {
  const defence = PRODUCTS.find((p) => p.sku === 'PCNWATCH_DEFENCE');

  return (
    <Section
      eyebrow="Pricing"
      title="Understanding your ticket is free."
      lede="No subscription, and no account needed to explore the map or decode a notice. You pay once, only if you want the full Defence Pack."
    >
      <div
        style={{
          display: 'grid',
          gap: 18,
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(280px, 100%), 1fr))',
          alignItems: 'stretch',
        }}
      >
        <GlassCard>
          <div className="fr-eyebrow">Free</div>
          <div className="fr-numeric" style={{ fontSize: 38, fontWeight: 700, marginTop: 10, letterSpacing: '-0.03em' }}>
            £0
          </div>
          <ul style={{ margin: '16px 0 0', paddingLeft: 18, fontSize: 14.5, color: 'var(--text-muted)', lineHeight: 1.7 }}>
            <li>Enforcement map and hotspot pages</li>
            <li>PCN scanning and verification</li>
            <li>Contravention explanations</li>
            <li>Evidence checklist</li>
            <li>The dates printed on your notice</li>
          </ul>
        </GlassCard>

        {defence && (
          <GlassCard accent="brand" style={{ borderColor: 'rgb(47 123 255 / 0.34)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <div className="fr-eyebrow">{defence.name}</div>
              <Pill accent="brand">One-off</Pill>
            </div>
            <div className="fr-numeric" style={{ fontSize: 38, fontWeight: 700, marginTop: 10, letterSpacing: '-0.03em' }}>
              {formatPence(defence.pricePence)}
            </div>
            <p style={{ margin: '12px 0 0', fontSize: 14.5, color: 'var(--text-muted)', lineHeight: 1.55 }}>
              {defence.description}
            </p>
            <ul style={{ margin: '14px 0 0', paddingLeft: 18, fontSize: 14, color: 'var(--text-muted)', lineHeight: 1.7 }}>
              {defence.includes.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <div style={{ marginTop: 20 }}>
              <CtaLink href="/analyse" icon={<ScanIcon size={18} />}>
                Start with your notice
              </CtaLink>
            </div>
          </GlassCard>
        )}
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* FAQs                                                                */
/* ------------------------------------------------------------------ */

const FAQS = [
  {
    q: 'Does a high Ticket Activity Score mean I will get a ticket?',
    a: 'No. The score compares historical enforcement activity between locations in the data we hold. It is not a probability, and we will not present it as one. A location with heavy past enforcement may see none today, and vice versa.',
  },
  {
    q: 'Does a low score mean I can park there?',
    a: 'No. Enforcement history tells you nothing about whether parking is permitted. Always read the signs and road markings at the location.',
  },
  {
    q: 'Why is the map only Camden?',
    a: 'Because that is where we currently hold enough published enforcement data to describe activity honestly. Claiming London-wide coverage we cannot support would make every other number on the site untrustworthy. Other boroughs are added as data becomes available — and scanning a notice already works well beyond Camden.',
  },
  {
    q: 'Will PCNWatch calculate my deadlines for me?',
    a: 'It shows you the dates printed on your notice, which you confirm as you go. It will not calculate a date from a timing rule that has not been legally reviewed, because a wrong deadline is the one mistake that could cost you your right to challenge at all.',
  },
  {
    q: 'Is PCNWatch a law firm?',
    a: 'No. PCNWatch provides information and document-preparation tools. It does not provide legal advice and does not guarantee that a challenge will succeed. You submit your own challenge and your own appeal.',
  },
];

function Faqs() {
  return (
    <Section eyebrow="Questions" title="Straight answers">
      <div style={{ display: 'grid', gap: 12, maxWidth: 820 }}>
        {FAQS.map((faq) => (
          <details key={faq.q} className="fr-glass fr-rise" style={{ padding: '16px 20px' }}>
            <summary
              className="fr-touch"
              style={{
                cursor: 'pointer',
                fontSize: 16,
                fontWeight: 600,
                letterSpacing: '-0.01em',
                display: 'flex',
                alignItems: 'center',
              }}
            >
              {faq.q}
            </summary>
            <p style={{ margin: '10px 0 0', fontSize: 14.5, color: 'var(--text-muted)', lineHeight: 1.6, maxWidth: '62ch' }}>
              {faq.a}
            </p>
          </details>
        ))}
      </div>
    </Section>
  );
}
