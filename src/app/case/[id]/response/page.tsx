import Link from 'next/link';
import { getCase } from '@/server/repositories/cases';
import { STAGE_LABELS } from '@/core/case/state-machine';
import { Card, Disclaimer } from '@/components/primitives';
import { CaseUnavailable } from '../CaseUnavailable';

/**
 * Council correspondence.
 *
 * Uploading a response never changes the case stage on its own. The state machine
 * requires both a confident classification and the user's confirmation, because
 * moving a case forward wrongly narrows the options a user has left.
 */
export default async function ResponsePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await getCase(id);
  if (result.kind !== 'FOUND') {
    return (
      <CaseUnavailable
        kind={result.kind}
        correlationId={result.kind === 'UNAVAILABLE' ? result.correlationId : undefined}
      />
    );
  }

  return (
    <div className="fr-container" style={{ paddingBlock: 28, maxWidth: 800 }}>
      <nav aria-label="Breadcrumb" style={{ fontSize: 13, marginBottom: 12 }}>
        <Link href={`/case/${id}`} style={{ color: 'var(--text-muted)' }}>
          ← Back to case
        </Link>
      </nav>

      <h1 style={{ fontSize: 'clamp(23px, 3.4vw, 32px)', fontWeight: 630 }}>Council response</h1>
      <p style={{ marginTop: 10, color: 'var(--text-muted)', fontSize: 16, maxWidth: 620 }}>
        Upload anything the authority has sent you. We identify what it is, work out what it means
        for your deadlines, and — for a Notice of Rejection — compare it against what you actually
        submitted.
      </p>

      <Card style={{ marginTop: 22 }}>
        <div className="fr-eyebrow" style={{ marginBottom: 8 }}>
          Current stage
        </div>
        <div style={{ fontSize: 18, fontWeight: 620 }}>
          {STAGE_LABELS[result.record.proceduralStage]}
        </div>
        <p style={{ margin: '10px 0 0', fontSize: 14.5, color: 'var(--text-muted)' }}>
          Uploading a document does not move your case on by itself. We will show you what we read,
          and the stage changes only once you confirm it. Getting this wrong would narrow the
          options you have left, so we would rather ask.
        </p>
      </Card>

      <Card style={{ marginTop: 16 }}>
        <h2 style={{ fontSize: 16, fontWeight: 620, marginBottom: 10 }}>What you can upload</h2>
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 14.5, color: 'var(--text-muted)', display: 'grid', gap: 6 }}>
          <li>Notice to Owner</li>
          <li>Notice of Rejection</li>
          <li>Notice of Acceptance</li>
          <li>Charge Certificate</li>
          <li>Any other correspondence about this notice</li>
        </ul>
        <p style={{ margin: '14px 0 0', fontSize: 14, color: 'var(--text-faint)' }}>
          Document reading requires the AI integration, which is not configured on this deployment.
          You can still record the dates by hand, and your deadlines will be calculated from them.
        </p>
      </Card>

      <Card style={{ marginTop: 16 }}>
        <h2 style={{ fontSize: 16, fontWeight: 620, marginBottom: 10 }}>
          If your representations were rejected
        </h2>
        <p style={{ margin: 0, fontSize: 14.5, color: 'var(--text-muted)' }}>
          We identify the reasons the authority gave, compare them against the points you made, and
          show which of your arguments and which pieces of evidence the response does not appear to
          address. We record the appeal deadline and explain the next procedural option.
        </p>
        <p style={{ margin: '12px 0 0', fontSize: 14, color: 'var(--text-muted)' }}>
          We do not predict what an adjudicator would decide, and FineRadar never submits an appeal
          for you.
        </p>
      </Card>

      <div style={{ marginTop: 28 }}>
        <Disclaimer />
      </div>
    </div>
  );
}
