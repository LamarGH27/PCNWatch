'use client';

import Link from 'next/link';
import { EVIDENCE_DEFINITIONS } from '@/core/evidence/definitions';
import type { EvidenceType } from '@/core/evidence/types';
import { EVIDENCE_BASIS_LABELS } from '@/core/assessment/types';
import { maskPcnNumber, type VerifiedAssessment, type VerifiedFacts } from '@/server/cases/assess-verified';

/**
 * The free assessment.
 *
 * Everything shown is produced by the rules engines and the approved reference
 * store. Nothing here is generated: where PCNWatch holds no approved meaning
 * for a contravention it says so, and where the deadline engine refuses a date
 * the refusal is shown rather than a plausible-looking guess.
 *
 * The evidence basis describes what evidence exists, not the chance of winning
 * an appeal. That distinction is the reason the wording never mentions odds.
 */

const STAGE_LABELS: Record<string, string> = {
  NEW: 'Penalty charge notice issued',
  INFORMAL_CHALLENGE: 'Informal challenge made',
  NOTICE_TO_OWNER: 'Notice to Owner served',
  FORMAL_REPRESENTATION: 'Formal representations made',
  NOTICE_OF_ACCEPTANCE: 'Representations accepted',
  NOTICE_OF_REJECTION: 'Representations rejected',
  TRIBUNAL_ELIGIBLE: 'Eligible to appeal to the tribunal',
  TRIBUNAL_APPEAL: 'Appeal lodged with the tribunal',
  CLOSED_PAID: 'Paid',
  CLOSED_WON: 'Cancelled',
  CLOSED_LOST: 'Closed',
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginTop: 26 }}>
      <h2 style={{ fontSize: 17, fontWeight: 620, marginBottom: 10 }}>{title}</h2>
      {children}
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 12,
        justifyContent: 'space-between',
        padding: '7px 0',
        borderBottom: '1px solid var(--border)',
        fontSize: 14.5,
      }}
    >
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span style={{ fontWeight: 550, textAlign: 'right', wordBreak: 'break-word' }}>{value}</span>
    </div>
  );
}

/**
 * Where a line on this page came from.
 *
 * Three things sit side by side in the findings list and a reader must never
 * have to guess which is which: an account the user gave us, evidence somebody
 * holds, and a conclusion PCNWatch reached from the rules. The last carries
 * weight the first two do not, and an unlabelled list quietly lends PCNWatch's
 * authority to whatever the user typed.
 */
function provenanceOf(findingId: string): { label: string; tone: 'USER' | 'PCNWATCH' } {
  return findingId.startsWith('context-')
    ? { label: 'You told us', tone: 'USER' }
    : { label: 'PCNWatch finding', tone: 'PCNWATCH' };
}

export function AssessmentView({
  result,
  facts,
  onEdit,
  onEditContext,
  contextAnswered,
}: {
  result: VerifiedAssessment;
  facts: VerifiedFacts;
  onEdit: () => void;
  onEditContext?: () => void;
  contextAnswered?: boolean;
}) {
  const { assessment } = result;

  if (!result.supported) {
    return (
      <div className="fr-panel" style={{ padding: 24, marginTop: 24 }} role="status">
        <h2 style={{ fontSize: 18, fontWeight: 620, marginBottom: 8 }}>
          This notice is outside what PCNWatch supports
        </h2>
        <p style={{ margin: 0, fontSize: 15, color: 'var(--text-muted)' }}>
          {result.unsupportedMessage}
        </p>
        <p style={{ marginTop: 16, fontSize: 14 }}>
          <button type="button" onClick={onEdit} style={linkButton}>
            Check the details we read
          </button>
        </p>
      </div>
    );
  }

  const evidenceNeeded = [
    ...new Set(assessment.findings.flatMap((f) => f.evidenceNeeded)),
  ] as EvidenceType[];

  return (
    <div style={{ marginTop: 24 }}>
      <div className="fr-panel" style={{ padding: '16px 18px' }}>
        <div className="fr-eyebrow" style={{ marginBottom: 4 }}>
          Free assessment
        </div>
        <h2 style={{ fontSize: 19, fontWeight: 640 }}>
          {EVIDENCE_BASIS_LABELS[assessment.basis]}
        </h2>
        <p style={{ margin: '8px 0 0', fontSize: 14.5, color: 'var(--text-muted)' }}>
          {assessment.basisExplanation}
        </p>
        <p style={{ margin: '10px 0 0', fontSize: 13, color: 'var(--text-faint)' }}>
          This describes the evidence you currently have, not your chance of winning an appeal.
        </p>
      </div>

      {result.authority.coverageNote && (
        <div
          style={{
            marginTop: 14,
            padding: '12px 14px',
            border: '1px solid var(--border-strong)',
            borderRadius: 'var(--radius-md)',
            fontSize: 13.5,
            lineHeight: 1.5,
            color: 'var(--text-muted)',
          }}
        >
          {result.authority.coverageNote}
        </div>
      )}

      <Section title="Your PCN">
        <div>
          {facts.authorityName && <Row label="Issuing authority" value={facts.authorityName} />}
          {facts.pcnNumber && <Row label="PCN number" value={maskPcnNumber(facts.pcnNumber)} />}
          {facts.vehicleRegistration && (
            <Row label="Vehicle registration" value={facts.vehicleRegistration} />
          )}
          {result.contravention.code && (
            <Row label="Contravention code" value={result.contravention.code} />
          )}
          {facts.incidentDate && (
            <Row
              label="Date"
              value={facts.incidentTime ? `${facts.incidentDate} at ${facts.incidentTime}` : facts.incidentDate}
            />
          )}
          {facts.location && <Row label="Location" value={facts.location} />}
          {result.amountSummary.full && <Row label="Full amount" value={result.amountSummary.full} />}
          {result.amountSummary.discounted && (
            <Row label="Discounted amount" value={result.amountSummary.discounted} />
          )}
        </div>
      </Section>

      <Section title="What this PCN means">
        {result.contravention.meaning ? (
          <>
            <p style={{ margin: 0, fontSize: 15 }}>{result.contravention.meaning}</p>
            {result.contravention.citation && (
              <p style={{ margin: '8px 0 0', fontSize: 12.5, color: 'var(--text-faint)' }}>
                Source: {result.contravention.citation.sourceName}
              </p>
            )}
          </>
        ) : (
          <p style={{ margin: 0, fontSize: 15, color: 'var(--text-muted)' }}>
            PCNWatch does not yet hold a reviewed explanation for
            {result.contravention.code ? ` code ${result.contravention.code}` : ' this contravention'}.
            We will not describe what it means until we do.
          </p>
        )}
        {result.contravention.asPrintedOnNotice && (
          <p style={{ margin: '10px 0 0', fontSize: 13.5, color: 'var(--text-muted)' }}>
            Your notice describes it as: “{result.contravention.asPrintedOnNotice}”
          </p>
        )}
      </Section>

      <Section title="Where you are in the process">
        {result.stageIsKnown ? (
          <p style={{ margin: 0, fontSize: 15 }}>{STAGE_LABELS[result.stage] ?? result.stage}</p>
        ) : (
          <p style={{ margin: 0, fontSize: 15, color: 'var(--text-muted)' }}>
            Your notice does not tell us where in the process this case sits, so we are not
            guessing at it.
          </p>
        )}
      </Section>

      <Section title="Important dates">
        {result.printedDeadlines.length === 0 && result.calculatedDeadlines.length === 0 && (
          <p style={{ margin: 0, fontSize: 15, color: 'var(--text-muted)' }}>
            No dates could be established from what you confirmed.
          </p>
        )}

        {result.printedDeadlines.map((deadline) => (
          <div key={deadline.label} style={deadlineCard}>
            <strong style={{ fontSize: 15 }}>{deadline.label}</strong>
            <div style={{ fontSize: 20, fontWeight: 640, marginTop: 2 }}>{deadline.date}</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-faint)', marginTop: 4 }}>
              Printed on your notice
            </div>
          </div>
        ))}

        {result.calculatedDeadlines.map((deadline) => (
          <div key={deadline.label} style={deadlineCard}>
            <strong style={{ fontSize: 15 }}>{deadline.label}</strong>
            <div style={{ fontSize: 20, fontWeight: 640, marginTop: 2 }}>{deadline.date}</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-faint)', marginTop: 4 }}>
              Worked out by PCNWatch from {deadline.basis}. Always check against your notice.
            </div>
            {deadline.warnings.map((warning) => (
              <div key={warning} style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 4 }}>
                {warning}
              </div>
            ))}
          </div>
        ))}

        {result.refusedDeadlines.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <p style={{ margin: '0 0 6px', fontSize: 13.5, color: 'var(--text-muted)' }}>
              Deadlines we could not work out:
            </p>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13.5, color: 'var(--text-muted)' }}>
              {result.refusedDeadlines.map((refusal) => (
                <li key={refusal.label} style={{ marginBottom: 4 }}>
                  {refusal.message}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Section>

      {assessment.findings.length > 0 && (
        <Section title="Things worth checking">
          <p style={{ margin: '0 0 10px', fontSize: 13.5, color: 'var(--text-muted)' }}>
            These are questions to answer, not grounds you already have. Whether any of them helps
            depends on evidence you have not gathered yet.
          </p>
          {assessment.findings.map((finding) => {
            const provenance = provenanceOf(finding.id);
            return (
              <div key={finding.id} style={{ ...deadlineCard, marginTop: 10 }}>
                <span
                  style={{
                    display: 'inline-block',
                    marginBottom: 6,
                    padding: '2px 8px',
                    borderRadius: 999,
                    fontSize: 11,
                    fontWeight: 620,
                    letterSpacing: '0.06em',
                    textTransform: 'uppercase',
                    border: '1px solid var(--border-strong)',
                    color: provenance.tone === 'USER' ? 'var(--text-muted)' : 'var(--text)',
                  }}
                >
                  {provenance.label}
                </span>
                <strong style={{ fontSize: 15, display: 'block' }}>{finding.issue}</strong>
                <p style={{ margin: '6px 0 0', fontSize: 14, color: 'var(--text-muted)' }}>
                  {finding.whyItMayMatter}
                </p>
              </div>
            );
          })}
        </Section>
      )}

      {evidenceNeeded.length > 0 && (
        <Section title="Evidence to gather">
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 14.5 }}>
            {evidenceNeeded.map((type) => {
              const definition = EVIDENCE_DEFINITIONS[type];
              if (!definition) return null;
              return (
                <li key={type} style={{ marginBottom: 10 }}>
                  <strong>{definition.label}</strong>
                  <div style={{ fontSize: 13.5, color: 'var(--text-muted)', marginTop: 2 }}>
                    {definition.howToCapture}
                  </div>
                </li>
              );
            })}
          </ul>
        </Section>
      )}

      {assessment.missingInformation.length > 0 && (
        <Section title="Missing information">
          <p style={{ margin: '0 0 8px', fontSize: 13.5, color: 'var(--text-muted)' }}>
            PCNWatch could say more if it knew:
          </p>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 14.5 }}>
            {assessment.missingInformation.map((item) => (
              <li key={item} style={{ marginBottom: 6 }}>
                {item}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {onEditContext && !contextAnswered && (
        <div className="fr-panel" style={{ padding: '14px 16px', marginTop: 22 }}>
          <strong style={{ fontSize: 15 }}>This assessment only knows what your notice says.</strong>
          <p style={{ margin: '6px 0 10px', fontSize: 14, color: 'var(--text-muted)', lineHeight: 1.5 }}>
            You have not told us what actually happened, so everything above is drawn from the
            authority&rsquo;s side of it. A few sentences about your own case is the single thing
            that would improve this most.
          </p>
          <button type="button" onClick={onEditContext} className="fr-touch" style={secondaryAction}>
            Tell us what happened
          </button>
        </div>
      )}

      <p
        style={{
          marginTop: 24,
          fontSize: 12.5,
          color: 'var(--text-faint)',
          lineHeight: 1.5,
        }}
      >
        This assessment is worked out on the spot from what you confirmed. Nothing about your
        notice is stored — leave this page and you will need to upload it again.
      </p>

      <div
        style={{
          marginTop: 20,
          display: 'flex',
          gap: 10,
          flexWrap: 'wrap',
          paddingTop: 16,
          borderTop: '1px solid var(--border)',
        }}
      >
        <button type="button" onClick={onEdit} className="fr-touch" style={secondaryAction}>
          Edit verified details
        </button>
        {onEditContext && (
          <button
            type="button"
            onClick={onEditContext}
            className="fr-touch"
            style={secondaryAction}
          >
            {contextAnswered ? 'Change what you told us' : 'Tell us what happened'}
          </button>
        )}
        {facts.location && (
          <Link href="/map" className="fr-touch" style={{ ...secondaryAction, textDecoration: 'none' }}>
            Check this location on the map
          </Link>
        )}
      </div>
    </div>
  );
}

const deadlineCard: React.CSSProperties = {
  border: '1px solid var(--border-strong)',
  borderRadius: 'var(--radius-md)',
  padding: '12px 14px',
  marginTop: 10,
  background: 'var(--surface-raised)',
};

const secondaryAction: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '0 16px',
  border: '1px solid var(--border-strong)',
  borderRadius: 'var(--radius-md)',
  background: 'var(--surface-raised)',
  color: 'var(--text)',
  fontSize: 14.5,
  fontWeight: 550,
  cursor: 'pointer',
};

const linkButton: React.CSSProperties = {
  background: 'none',
  border: 'none',
  padding: 0,
  color: 'var(--color-accent, #06c)',
  textDecoration: 'underline',
  cursor: 'pointer',
  fontSize: 14,
};
