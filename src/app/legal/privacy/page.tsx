import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Privacy',
  description:
    'What personal data PCNWatch holds, why, for how long, and how to delete it.',
  alternates: { canonical: '/legal/privacy' },
};

export default function PrivacyPage() {
  return (
    <div className="fr-container" style={{ paddingBlock: 40, maxWidth: 740 }}>
      <h1 style={{ fontSize: 'clamp(26px, 4vw, 36px)', fontWeight: 630 }}>Privacy</h1>
      <p style={{ marginTop: 12, fontSize: 16, color: 'var(--text-muted)' }}>
        A PCN case contains information about where a specific vehicle was at a specific time. We
        treat that as sensitive and collect as little of it as the job requires.
      </p>

      <Section title="What we hold">
        <ul style={list}>
          <li>Vehicle registrations you add, so a case can be matched to a vehicle.</li>
          <li>The notices and evidence you upload.</li>
          <li>The details extracted from those documents, and the corrections you make.</li>
          <li>A record of payments, so you keep access to what you bought.</li>
        </ul>
      </Section>

      <Section title="How your case is identified">
        <p style={paragraph}>
          We do not ask you to create an account and we do not ask for your email address. When you
          save a case, your browser is given an anonymous identity, and the case belongs to that.
          It is what lets your cases be private to you without us holding anything that identifies
          you as a person.
        </p>
        <p style={{ ...paragraph, marginTop: 12 }}>
          The trade-off is worth stating plainly: because the identity lives in your browser,
          clearing this site&rsquo;s data or moving to another device means losing the way back to
          your case. Account recovery is coming later.
        </p>
        <p style={{ ...paragraph, marginTop: 12 }}>
          Separately, the small number of people who operate PCNWatch sign in to an internal
          dashboard with an email address. That is a staff sign-in and has nothing to do with
          customer cases: no customer is asked for an email address, and no customer account
          exists to sign in to.
        </p>
      </Section>

      <Section title="What we do not ask for">
        <p style={paragraph}>
          We do not ask for your home address unless a document you are generating actually needs a
          correspondence address on it. We do not ask for your date of birth, your driving licence,
          or anything else a challenge does not require.
        </p>
      </Section>

      <Section title="Who can see it">
        <p style={paragraph}>
          Your cases, documents, evidence and drafts are readable only by you. This is enforced in
          the database by row-level security, not only in application code, and documents are held
          in private storage that requires a signed request scoped to your account. Nobody browsing
          the site can reach another person&rsquo;s case.
        </p>
      </Section>

      <Section title="Where AI fits">
        <p style={paragraph}>
          When you ask us to read a document, its contents are sent to our model provider for that
          request. We do not send unnecessary personal information alongside it. Our audit log of
          model calls stores a one-way fingerprint of the input rather than the input itself, so the
          log never contains your PCN number, registration or documents.
        </p>
      </Section>

      <Section title="Enforcement data contains no personal data">
        <p style={paragraph}>
          The public map and hotspot pages are built from published local-authority datasets. Our
          ingestion strips any field that could identify a person or a vehicle before it is stored,
          and scrubs registration-shaped text out of the fields it does keep — including when the
          source includes something it should not have.
        </p>
      </Section>

      <Section title="Deleting things">
        <ul style={list}>
          <li>Delete an individual piece of evidence at any time from the case.</li>
          <li>Delete a whole case, which removes its documents, evidence, drafts and deadlines.</li>
          <li>
            Delete everything held for your browser&rsquo;s anonymous identity, which removes
            everything above along with the vehicles you added.
          </li>
        </ul>
        <p style={paragraph}>
          Deletion removes the stored files as well as the database rows. We keep a minimal record
          that a payment occurred, without case details, where we are required to.
        </p>
      </Section>

      <Section title="Website analytics">
        <p style={paragraph}>
          We use Vercel Web Analytics to understand how the website is used overall &mdash; how many
          visits the site receives, which pages people read, and where they arrived from. We use it
          to see whether the product is working and worth continuing, not to build a picture of any
          individual.
        </p>
        <p style={{ ...paragraph, marginTop: 12 }}>
          It sets no cookies. It does not retain your IP address; it derives a short-lived
          identifier from your request so that one visit is counted once, and that identifier is
          changed daily and cannot be traced back to you. There are no advertising or marketing
          cookies on this site, and nothing here follows you to other websites.
        </p>
        <p style={{ ...paragraph, marginTop: 12 }}>
          The analytics are aggregate counts only. Nothing from your case reaches them &mdash; not
          your PCN number, your registration, your documents, your evidence or anything you wrote.
        </p>
      </Section>

      <Section title="Retention">
        <p style={paragraph}>
          You can set a retention period on your account, after which closed cases are removed
          automatically. If you do not set one, closed cases are kept until you delete them.
        </p>
      </Section>
    </div>
  );
}

const paragraph: React.CSSProperties = { margin: 0, fontSize: 16, color: 'var(--text-muted)' };
const list: React.CSSProperties = {
  margin: 0,
  paddingLeft: 20,
  fontSize: 16,
  color: 'var(--text-muted)',
  display: 'grid',
  gap: 6,
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginTop: 30 }}>
      <h2 style={{ fontSize: 19, fontWeight: 620, marginBottom: 10 }}>{title}</h2>
      {children}
    </section>
  );
}
