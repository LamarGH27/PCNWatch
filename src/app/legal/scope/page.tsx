import type { Metadata } from 'next';
import Link from 'next/link';
import { COVERAGE_SCOPE } from '@/core/coverage/coverage';
import { SCORE_DISCLAIMER } from '@/core/scoring/config';

export const metadata: Metadata = {
  title: 'What FineRadar does and does not do',
  description:
    'FineRadar is an information and document-preparation product, not a law firm. What it covers, what it will not claim, and where its limits are.',
  alternates: { canonical: '/legal/scope' },
};

export default function ScopePage() {
  return (
    <div className="fr-container" style={{ paddingBlock: 40, maxWidth: 740 }}>
      <h1 style={{ fontSize: 'clamp(26px, 4vw, 36px)', fontWeight: 630 }}>
        What FineRadar does and does not do
      </h1>

      <Block title="This is not legal advice">
        FineRadar provides information and document-preparation tools. It does not provide legal
        advice and does not guarantee that a challenge will succeed. It is not a law firm and no
        solicitor–client relationship is created by using it. If your case matters enough to need
        advice, get advice.
      </Block>

      <Block title="You submit your own challenge">
        We prepare documents. You review them, edit them, and send them yourself. FineRadar never
        submits a challenge, a representation or an appeal on your behalf, and never contacts an
        authority or a tribunal for you.
      </Block>

      <Block title="What the enforcement map is">
        The map shows where penalty charge notices have historically been recorded in published
        datasets. {SCORE_DISCLAIMER}
      </Block>

      <Block title="Activity is not permission">
        A location with little recorded enforcement may still be a location where parking is
        prohibited. A location with heavy recorded enforcement may be perfectly legal to park in at
        the right time with the right permit. The two questions are unrelated, and only the signs
        and road markings at the location answer the second one.
      </Block>

      <Block title="Coverage">
        {COVERAGE_SCOPE.statement} {COVERAGE_SCOPE.explanation} Where we do not hold data, the
        product says so rather than showing an estimate.
      </Block>

      <Block title="Local-authority PCNs only">
        This version handles penalty charge notices issued by local authorities. Private parking
        charges — issued by operators on private land under contract — follow an entirely different
        process, with different deadlines, different grounds and a different appeal route. If you
        upload one we will identify it and stop, rather than applying the wrong rules to it.
      </Block>

      <Block title="Where AI is used, and where it is not">
        A language model reads uploaded documents and improves the structure and clarity of a draft.
        It is never the source of a legal or procedural rule. Rules come from a versioned store of
        approved references, each with a citation. Deadlines are calculated deterministically from
        those rules — a model is never asked to work out a date. Any model output that cites
        something not in the approved store is rejected and never shown to you.
      </Block>

      <Block title="What we will not do">
        We will not state a probability that you will receive a ticket, or that a challenge will
        succeed. We will not invent a case, a regulation or an exemption. We will not present
        demonstration data as real. Where the honest answer is that we do not know, that is the
        answer you will get.
      </Block>

      <p style={{ marginTop: 32, fontSize: 14 }}>
        <Link href="/legal/sources">Where our data comes from →</Link>
      </p>
    </div>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginTop: 30 }}>
      <h2 style={{ fontSize: 19, fontWeight: 620, marginBottom: 8 }}>{title}</h2>
      <p style={{ margin: 0, fontSize: 16, color: 'var(--text-muted)' }}>{children}</p>
    </section>
  );
}
