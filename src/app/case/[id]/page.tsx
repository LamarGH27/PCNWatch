import Link from 'next/link';
import { getCase } from '@/server/repositories/cases';
import { buildCaseView, type NextActionUrgency } from '@/server/cases/case-view';
import { getContravention } from '@/core/reference/store';
import { EVIDENCE_BASIS_LABELS } from '@/core/assessment/types';
import { Card, DataPoint, Disclaimer, formatDateTime, formatPence } from '@/components/primitives';
import { CaseUnavailable } from './CaseUnavailable';

export default async function CasePage({ params }: { params: Promise<{ id: string }> }) {
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

  const today = new Date().toISOString().slice(0, 10);
  const view = buildCaseView(result.record, today);
  const record = result.record;
  const contravention = record.contraventionCode
    ? getContravention(record.contraventionCode)
    : undefined;

  return (
    <div className="fr-container" style={{ paddingBlock: 28, maxWidth: 940 }}>
      <div className="fr-eyebrow" style={{ marginBottom: 6 }}>
        Case {record.pcnNumber ?? 'without a PCN number'}
      </div>
      <h1 style={{ fontSize: 'clamp(23px, 3.4vw, 32px)', fontWeight: 630 }}>
        {record.locationText ?? 'Location not recorded'}
      </h1>
      <p style={{ marginTop: 6, color: 'var(--text-muted)', fontSize: 15 }}>
        {record.authorityName ?? 'Authority not identified'}
        {record.incidentDate ? ` · ${formatDateTime(record.incidentDate)}` : ''}
      </p>

      {view.outOfScopeMessage && (
        <div
          role="status"
          style={{
            marginTop: 20,
            border: '1px solid var(--color-warn)',
            background: 'color-mix(in srgb, var(--color-warn) 10%, transparent)',
            borderRadius: 'var(--radius-md)',
            padding: '14px 16px',
          }}
        >
          <strong style={{ fontSize: 15 }}>{view.outOfScopeMessage}</strong>
          <p style={{ margin: '6px 0 0', fontSize: 14, color: 'var(--text-muted)' }}>
            We have not applied local-authority rules, deadlines or grounds to this notice.
          </p>
        </div>
      )}

      {/* Next action — the single most important thing on the page. */}
      <NextActionPanel
        headline={view.nextAction.headline}
        detail={view.nextAction.detail}
        urgency={view.nextAction.urgency}
      />

      {/* Headline figures */}
      <div
        style={{
          marginTop: 20,
          display: 'grid',
          gap: 14,
          gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
        }}
      >
        <Card>
          <DataPoint label="Stage" value={view.stageLabel} hint={view.stageExplanation ?? undefined} />
        </Card>
        <Card>
          <DataPoint
            label="Currently payable"
            value={
              view.financialExposure.currentlyPayablePence === null
                ? '—'
                : formatPence(view.financialExposure.currentlyPayablePence)
            }
            hint={view.financialExposure.note}
          />
        </Card>
        <Card>
          <DataPoint
            label="Contravention"
            value={record.contraventionCode ?? '—'}
            hint={contravention?.summary ?? 'Not recorded on this case.'}
          />
        </Card>
        <Card>
          <DataPoint
            label="Evidence"
            value={`${view.evidence.providedCount}/${view.evidence.items.length}`}
            hint={
              view.evidence.missingEssential.length > 0
                ? `${view.evidence.missingEssential.length} essential item${view.evidence.missingEssential.length === 1 ? '' : 's'} missing`
                : 'Nothing essential is missing'
            }
          />
        </Card>
      </div>

      {/* Deadlines */}
      <section style={{ marginTop: 32 }}>
        <h2 style={{ fontSize: 19, fontWeight: 620, marginBottom: 12 }}>Deadlines</h2>
        <Card padded={false}>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {view.deadlines.map((deadline, index) => (
              <li
                key={deadline.deadlineType}
                style={{
                  padding: '14px 18px',
                  borderTop: index === 0 ? 'none' : '1px solid var(--border)',
                }}
              >
                {'calculated' in deadline && deadline.calculated ? (
                  <>
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        gap: 14,
                        flexWrap: 'wrap',
                      }}
                    >
                      <strong style={{ fontSize: 15, fontWeight: 600 }}>{deadline.label}</strong>
                      <span
                        className="fr-numeric"
                        style={{
                          fontSize: 15,
                          color:
                            deadline.calculatedDueDate < today
                              ? 'var(--color-urgent)'
                              : 'var(--text)',
                        }}
                      >
                        {formatDateTime(deadline.calculatedDueDate)}
                      </span>
                    </div>
                    <p style={{ margin: '5px 0 0', fontSize: 13, color: 'var(--text-faint)' }}>
                      From {deadline.triggerDescription.toLowerCase()} (
                      {formatDateTime(deadline.triggerDate)}) · confidence{' '}
                      {deadline.confidence.toLowerCase()} · rule {deadline.calculationRule}
                    </p>
                    {deadline.warnings.map((warning) => (
                      <p
                        key={warning}
                        style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--color-warn)' }}
                      >
                        {warning}
                      </p>
                    ))}
                  </>
                ) : (
                  <>
                    <strong style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-muted)' }}>
                      {deadline.deadlineType.replace(/_/g, ' ').toLowerCase()}
                    </strong>
                    <p style={{ margin: '5px 0 0', fontSize: 13.5, color: 'var(--text-muted)' }}>
                      {'message' in deadline ? deadline.message : 'Not calculated.'}
                    </p>
                  </>
                )}
              </li>
            ))}
          </ul>
        </Card>
        <p style={{ marginTop: 10, fontSize: 12.5, color: 'var(--text-faint)', maxWidth: 640 }}>
          These dates are calculated from rules, not read from your notice. Always check them
          against the dates printed on the notice itself.
        </p>
      </section>

      {/* Assessment summary */}
      <section style={{ marginTop: 32 }}>
        <h2 style={{ fontSize: 19, fontWeight: 620, marginBottom: 12 }}>Where your case stands</h2>
        <Card>
          <div className="fr-eyebrow" style={{ marginBottom: 6 }}>
            Evidence basis
          </div>
          <div style={{ fontSize: 20, fontWeight: 620, marginBottom: 8 }}>
            {EVIDENCE_BASIS_LABELS[view.assessment.basis]}
          </div>
          <p style={{ margin: 0, fontSize: 14.5, color: 'var(--text-muted)' }}>
            {view.assessment.basisExplanation}
          </p>
          {view.assessment.missingInformation.length > 0 && (
            <ul
              style={{
                margin: '14px 0 0',
                paddingLeft: 18,
                fontSize: 13.5,
                color: 'var(--text-muted)',
                display: 'grid',
                gap: 5,
              }}
            >
              {view.assessment.missingInformation.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          )}
          <p style={{ marginTop: 14 }}>
            <Link href={`/case/${id}/assessment`} style={{ fontSize: 14.5, fontWeight: 550 }}>
              See the full assessment →
            </Link>
          </p>
        </Card>
      </section>

      {/* Navigation */}
      <nav
        aria-label="Case sections"
        style={{
          marginTop: 32,
          display: 'grid',
          gap: 10,
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
        }}
      >
        {[
          { href: `/case/${id}/evidence`, label: 'Evidence', detail: 'What to gather and why' },
          { href: `/case/${id}/assessment`, label: 'Assessment', detail: 'Findings and gaps' },
          { href: `/case/${id}/draft`, label: 'Challenge draft', detail: 'Editable document' },
          { href: `/case/${id}/response`, label: 'Council response', detail: 'Upload what they sent' },
        ].map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="fr-touch"
            style={{
              display: 'block',
              padding: '14px 16px',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-lg)',
              background: 'var(--surface-raised)',
              textDecoration: 'none',
              color: 'var(--text)',
            }}
          >
            <strong style={{ fontSize: 15, fontWeight: 600 }}>{item.label}</strong>
            <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 3 }}>
              {item.detail}
            </div>
          </Link>
        ))}
      </nav>

      <div style={{ marginTop: 32 }}>
        <Disclaimer />
      </div>
    </div>
  );
}

const URGENCY_STYLE: Record<NextActionUrgency, { border: string; label: string }> = {
  NONE: { border: 'var(--border-strong)', label: 'Nothing outstanding' },
  ROUTINE: { border: 'var(--border-strong)', label: 'Next step' },
  SOON: { border: 'var(--color-warn)', label: 'Coming up' },
  URGENT: { border: 'var(--color-urgent)', label: 'Act now' },
  OVERDUE: { border: 'var(--color-critical)', label: 'Passed' },
};

function NextActionPanel({
  headline,
  detail,
  urgency,
}: {
  headline: string;
  detail: string;
  urgency: NextActionUrgency;
}) {
  const style = URGENCY_STYLE[urgency];
  return (
    <div
      role={urgency === 'URGENT' || urgency === 'OVERDUE' ? 'alert' : 'status'}
      style={{
        marginTop: 24,
        border: `1px solid ${style.border}`,
        borderLeft: `4px solid ${style.border}`,
        borderRadius: 'var(--radius-md)',
        padding: '16px 18px',
        background: 'var(--surface-raised)',
      }}
    >
      <div className="fr-eyebrow" style={{ marginBottom: 6, color: style.border }}>
        {style.label}
      </div>
      <strong style={{ fontSize: 17, fontWeight: 620, display: 'block' }}>{headline}</strong>
      <p style={{ margin: '7px 0 0', fontSize: 14.5, color: 'var(--text-muted)' }}>{detail}</p>
    </div>
  );
}
