import type { Metadata } from 'next';
import Link from 'next/link';
import { COVERAGE_SCOPE } from '@/core/coverage/coverage';
import { PRODUCTS } from '@/server/payments/catalogue';
import { SCORE_DISCLAIMER } from '@/core/scoring/config';
import { Card, Disclaimer, Section, formatPence } from '@/components/primitives';

export const metadata: Metadata = {
  title: 'FineRadar — know before the ticket',
  description:
    'Explore where parking and traffic penalties are actually being issued. Already received a PCN? Decode it, organise your evidence and build your challenge.',
  alternates: { canonical: '/' },
  openGraph: {
    title: 'FineRadar — know before the ticket',
    description:
      'Enforcement intelligence for UK drivers. See where PCNs are actually issued, and what to do if you get one.',
    url: '/',
  },
};

export default function LandingPage() {
  return (
    <>
      <Hero />
      <EnforcementIntelligence />
      <HowItWorks />
      <ExampleHotspot />
      <PcnAnalysis />
      <Trust />
      <Pricing />
      <Faqs />
    </>
  );
}

/* ------------------------------------------------------------------ */

function Hero() {
  return (
    <section
      style={{
        borderBottom: '1px solid var(--border)',
        background:
          'linear-gradient(180deg, var(--surface) 0%, var(--surface-sunken) 100%)',
        paddingBlock: 'clamp(56px, 9vw, 104px)',
      }}
    >
      <div className="fr-container">
        <div style={{ maxWidth: 720 }}>
          <div className="fr-eyebrow" style={{ marginBottom: 18 }}>
            UK enforcement intelligence · {COVERAGE_SCOPE.shortStatement}
          </div>
          <h1
            style={{
              fontSize: 'clamp(38px, 6.4vw, 66px)',
              fontWeight: 640,
              lineHeight: 1.03,
              letterSpacing: '-0.035em',
            }}
          >
            Know before the ticket.
          </h1>
          <p
            style={{
              marginTop: 22,
              fontSize: 'clamp(17px, 2vw, 20px)',
              color: 'var(--text-muted)',
              maxWidth: 610,
            }}
          >
            Explore where parking and traffic penalties are actually being issued. Already
            received a PCN? Decode it, organise your evidence and build your challenge.
          </p>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 34 }}>
            <Link
              href="/map"
              className="fr-touch"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                padding: '0 24px',
                background: 'var(--color-ink-900)',
                color: 'var(--color-ink-50)',
                borderRadius: 'var(--radius-md)',
                fontWeight: 550,
                fontSize: 15,
                textDecoration: 'none',
              }}
            >
              Explore the map
            </Link>
            <Link
              href="/analyse"
              className="fr-touch"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                padding: '0 24px',
                border: '1px solid var(--border-strong)',
                borderRadius: 'var(--radius-md)',
                fontWeight: 550,
                fontSize: 15,
                color: 'var(--text)',
                textDecoration: 'none',
              }}
            >
              Analyse my PCN
            </Link>
          </div>

          <p style={{ marginTop: 22, fontSize: 13, color: 'var(--text-faint)', maxWidth: 560 }}>
            {COVERAGE_SCOPE.explanation}
          </p>
        </div>
      </div>
    </section>
  );
}

function EnforcementIntelligence() {
  return (
    <Section
      eyebrow="What makes this different"
      title="Most tools start when you already have a ticket. We start before."
      intro={
        <>
          <p style={{ marginTop: 0 }}>
            Enforcement is not evenly spread. A handful of streets account for a
            disproportionate share of penalty charge notices, concentrated into particular hours
            and particular days. That pattern is a matter of public record — it is just never
            presented in a form a driver can use.
          </p>
          <p>
            FineRadar reads published PCN data, normalises it, and shows you where activity has
            actually happened, when, and for which contraventions.
          </p>
        </>
      }
    >
      <div
        style={{
          display: 'grid',
          gap: 16,
          gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
        }}
      >
        {[
          {
            title: 'Historic activity, not predictions',
            body: 'We report what has been recorded. We never state a probability that you will be ticketed, because no defensible denominator for that exists.',
          },
            {
            title: 'Activity is not permission',
            body: 'A quiet street can still be a street you must not park on. Enforcement history and parking legality are different questions, and we keep them apart.',
          },
          {
            title: 'Every figure is traceable',
            body: 'Each number links back to the dataset it came from, when it was retrieved, and how confident we are in it. Where we do not have data, we say so.',
          },
        ].map((item) => (
          <Card key={item.title}>
            <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>{item.title}</h3>
            <p style={{ margin: 0, fontSize: 14.5, color: 'var(--text-muted)' }}>{item.body}</p>
          </Card>
        ))}
      </div>
    </Section>
  );
}

function HowItWorks() {
  const steps = [
    {
      n: '01',
      title: 'Explore enforcement activity',
      body: 'Open the map, search a street or postcode, and see the Ticket Activity Score, the dominant contraventions and the busiest times for that location.',
    },
    {
      n: '02',
      title: 'Upload your notice',
      body: 'Photograph the PCN. We extract the authority, contravention code, dates and amounts, then ask you to check every important field before anything is saved.',
    },
    {
      n: '03',
      title: 'See your deadlines and evidence gaps',
      body: 'Deadlines are calculated from rules, not guessed. The evidence checklist changes depending on the contravention and the grounds you are relying on.',
    },
    {
      n: '04',
      title: 'Build your challenge',
      body: 'We assess your evidence, show you what is missing, and prepare an editable draft. Every legal or procedural statement traces to an approved reference.',
    },
  ];

  return (
    <Section eyebrow="How FineRadar works" title="Four steps, in the order that actually helps.">
      <ol
        style={{
          listStyle: 'none',
          margin: 0,
          padding: 0,
          display: 'grid',
          gap: 1,
          background: 'var(--border)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)',
          overflow: 'hidden',
        }}
      >
        {steps.map((step) => (
          <li
            key={step.n}
            style={{
              background: 'var(--surface-raised)',
              padding: '22px 24px',
              display: 'grid',
              gap: 16,
              gridTemplateColumns: 'auto 1fr',
              alignItems: 'start',
            }}
          >
            <span
              className="fr-numeric"
              style={{ fontSize: 13, color: 'var(--text-faint)', fontWeight: 600, paddingTop: 2 }}
            >
              {step.n}
            </span>
            <div>
              <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 5 }}>{step.title}</h3>
              <p style={{ margin: 0, fontSize: 14.5, color: 'var(--text-muted)', maxWidth: 620 }}>
                {step.body}
              </p>
            </div>
          </li>
        ))}
      </ol>
    </Section>
  );
}

function ExampleHotspot() {
  return (
    <Section
      eyebrow="Example"
      title="What a location page tells you"
      intro="Every covered location gets a page like this. The figures below describe the structure of the page, not a real street — real figures only ever appear once the underlying data has been ingested."
      style={{ background: 'var(--surface-sunken)', borderBlock: '1px solid var(--border)' }}
    >
      <Card padded={false}>
        <div style={{ padding: '20px 22px', borderBottom: '1px solid var(--border)' }}>
          <div className="fr-eyebrow" style={{ marginBottom: 6 }}>
            Location page structure
          </div>
          <h3 style={{ fontSize: 19, fontWeight: 620 }}>Street name, London Borough</h3>
        </div>
        <ul
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'grid',
            gap: 1,
            background: 'var(--border)',
          }}
        >
          {[
            ['Ticket Activity Score', 'A 0–100 comparison against other locations in the same dataset, with its classification.'],
            ['Total PCNs and period', 'How many notices, over exactly what date range.'],
            ['Most common contraventions', 'Which codes dominate, and what each one means in plain English.'],
            ['Busiest days and times', 'When activity concentrates — only shown where the source records a time.'],
            ['Recent trend', 'Direction of change, damped where the counts are too small to be meaningful.'],
            ['Data confidence', 'How complete and precise the underlying records are for this location.'],
            ['Source and last update', 'Which dataset, under which licence, retrieved when.'],
          ].map(([label, body]) => (
            <li
              key={label}
              style={{
                background: 'var(--surface-raised)',
                padding: '14px 22px',
                display: 'grid',
                gap: 4,
              }}
            >
              <strong style={{ fontSize: 14, fontWeight: 600 }}>{label}</strong>
              <span style={{ fontSize: 13.5, color: 'var(--text-muted)' }}>{body}</span>
            </li>
          ))}
        </ul>
        <div style={{ padding: '16px 22px', borderTop: '1px solid var(--border)' }}>
          <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-faint)' }}>{SCORE_DISCLAIMER}</p>
        </div>
      </Card>
      <div style={{ marginTop: 20 }}>
        <Link href="/hotspots" style={{ fontSize: 15, fontWeight: 550 }}>
          See ranked hotspots →
        </Link>
      </div>
    </Section>
  );
}

function PcnAnalysis() {
  return (
    <Section
      eyebrow="Already have a PCN"
      title="Decode the notice, then decide."
      intro="A penalty charge notice is a dense document with several dates on it, only some of which matter to you. FineRadar reads it, tells you which stage you are at, and calculates the deadlines that follow."
    >
      <div
        style={{
          display: 'grid',
          gap: 16,
          gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))',
        }}
      >
        {[
          {
            title: 'You check what we read',
            body: 'Extraction is never trusted silently. Anything we are unsure about is flagged and you confirm it before it drives a deadline or a document.',
          },
          {
            title: 'Deadlines are calculated, not guessed',
            body: 'Dates come from rules with citations, computed deterministically. Where we do not know the trigger date, we say so instead of estimating.',
          },
          {
            title: 'Evidence, before argument',
            body: 'What matters depends on the contravention. A suspended bay case and a Blue Badge case need different photographs, and the checklist reflects that.',
          },
          {
            title: 'Evidence basis, not a win percentage',
            body: 'We tell you how well evidenced your case is, and what would strengthen it. We will not invent a probability of success.',
          },
        ].map((item) => (
          <Card key={item.title}>
            <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>{item.title}</h3>
            <p style={{ margin: 0, fontSize: 14.5, color: 'var(--text-muted)' }}>{item.body}</p>
          </Card>
        ))}
      </div>

      <div style={{ marginTop: 28 }}>
        <Disclaimer />
      </div>
    </Section>
  );
}

function Trust() {
  return (
    <Section
      eyebrow="Where the information comes from"
      title="Published data, cited rules, and an honest account of the gaps."
      style={{ background: 'var(--surface-sunken)', borderBlock: '1px solid var(--border)' }}
    >
      <div
        style={{
          display: 'grid',
          gap: 16,
          gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
        }}
      >
        {[
          {
            title: 'Enforcement data',
            body: 'Published local-authority PCN datasets, ingested with full provenance: which source, which version, retrieved when, and how many rows were rejected and why.',
            link: { href: '/legal/sources', label: 'Data sources' },
          },
          {
            title: 'Legal and procedural rules',
            body: 'A versioned store of approved references, each with a citation a reviewer can open. Language models may improve how a point is expressed; they are never the source of the point.',
            link: { href: '/codes', label: 'Contravention codes' },
          },
          {
            title: 'What we will not do',
            body: 'We will not fabricate statistics, invent case law, claim coverage we do not have, or promise an outcome. Where the honest answer is "we do not know", that is the answer you get.',
            link: { href: '/legal/scope', label: 'Scope and limits' },
          },
        ].map((item) => (
          <Card key={item.title}>
            <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>{item.title}</h3>
            <p style={{ margin: '0 0 12px', fontSize: 14.5, color: 'var(--text-muted)' }}>
              {item.body}
            </p>
            <Link href={item.link.href} style={{ fontSize: 14, fontWeight: 550 }}>
              {item.link.label} →
            </Link>
          </Card>
        ))}
      </div>
    </Section>
  );
}

function Pricing() {
  return (
    <Section
      eyebrow="Pricing"
      title="The map is free. You pay only if you want the full defence pack."
      intro="No subscription. No account needed to explore enforcement data."
    >
      <div
        style={{
          display: 'grid',
          gap: 16,
          gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))',
          alignItems: 'start',
        }}
      >
        <Card>
          <div className="fr-eyebrow" style={{ marginBottom: 8 }}>
            Free
          </div>
          <div className="fr-numeric" style={{ fontSize: 30, fontWeight: 640, marginBottom: 14 }}>
            £0
          </div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 14.5, color: 'var(--text-muted)' }}>
            <li>Enforcement map and hotspot pages</li>
            <li>PCN extraction and verification</li>
            <li>Contravention explanations</li>
            <li>Basic evidence checklist</li>
            <li>Deadline tracking</li>
          </ul>
        </Card>

        {PRODUCTS.map((product) => (
          <Card key={product.sku}>
            <div className="fr-eyebrow" style={{ marginBottom: 8 }}>
              {product.name}
            </div>
            <div className="fr-numeric" style={{ fontSize: 30, fontWeight: 640, marginBottom: 14 }}>
              {formatPence(product.pricePence)}
              <span style={{ fontSize: 13, fontWeight: 400, color: 'var(--text-faint)' }}>
                {' '}
                one-off
              </span>
            </div>
            <p style={{ margin: '0 0 12px', fontSize: 14.5, color: 'var(--text-muted)' }}>
              {product.description}
            </p>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 14, color: 'var(--text-muted)' }}>
              {product.includes.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </Card>
        ))}
      </div>
    </Section>
  );
}

function Faqs() {
  const faqs = [
    {
      q: 'Does a high Ticket Activity Score mean I will get a ticket?',
      a: 'No. The score compares historical enforcement activity between locations in the data we hold. It is not a probability, and we will not present it as one. A location with heavy past enforcement may see none today, and vice versa.',
    },
    {
      q: 'Does a low score mean I can park there?',
      a: 'No. Enforcement history tells you nothing about whether parking is permitted. Always read the signs and road markings at the location.',
    },
    {
      q: 'Why is only Camden covered?',
      a: 'Because that is where we currently hold enough published enforcement data to describe activity honestly. Claiming London-wide coverage we cannot support would make every other number on the site untrustworthy. Other boroughs are added as data becomes available.',
    },
    {
      q: 'Is FineRadar a law firm?',
      a: 'No. FineRadar provides information and document-preparation tools. It does not provide legal advice and does not guarantee that a challenge will succeed. You submit your own challenge and your own appeal.',
    },
    {
      q: 'Do you use AI, and where?',
      a: 'We use a language model to read documents and to improve the structure and clarity of a draft. It is never the source of legislation or procedure: rules and evidence are evaluated first, deterministically, and the model may only cite references that exist in our approved store.',
    },
    {
      q: 'What about private parking tickets?',
      a: 'This version focuses on local-authority PCNs. Private parking charges follow a different process, so if you upload one we will tell you rather than applying the wrong rules to it.',
    },
    {
      q: 'What happens to my data?',
      a: 'Your notices and evidence are stored privately and are readable only by you. You can delete a case, delete individual evidence, or delete your account entirely. We do not ask for your home address unless a document you are generating actually requires it.',
    },
  ];

  return (
    <Section eyebrow="Questions" title="Frequently asked">
      <div
        style={{
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)',
          overflow: 'hidden',
        }}
      >
        {faqs.map((faq, i) => (
          <details
            key={faq.q}
            style={{
              borderTop: i === 0 ? 'none' : '1px solid var(--border)',
              background: 'var(--surface-raised)',
            }}
          >
            <summary
              className="fr-touch"
              style={{
                cursor: 'pointer',
                padding: '15px 20px',
                fontSize: 15,
                fontWeight: 550,
                display: 'flex',
                alignItems: 'center',
              }}
            >
              {faq.q}
            </summary>
            <p
              style={{
                margin: 0,
                padding: '0 20px 18px',
                fontSize: 14.5,
                color: 'var(--text-muted)',
                maxWidth: 700,
              }}
            >
              {faq.a}
            </p>
          </details>
        ))}
      </div>
    </Section>
  );
}
