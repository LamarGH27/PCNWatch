'use client';

import { useCallback, useId, useRef, useState } from 'react';
import { EVIDENCE_DEFINITIONS } from '@/core/evidence/definitions';
import type { VerifiedAssessment, VerifiedFacts } from '@/server/cases/assess-verified';
import { AssessmentView } from './AssessmentView';

/**
 * The upload → extract → verify flow.
 *
 * Written for the mobile case first: someone standing beside their car, holding
 * the notice, one hand free. The camera is the primary input, touch targets are
 * large, and text entry is only asked for when we genuinely could not read
 * something.
 *
 * The verification step is not a formality. Nothing extracted is treated as fact
 * until the user confirms it, and the fields that drive deadlines are always
 * shown for confirmation regardless of how confident the model was.
 */

const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const MAX_BYTES = 12 * 1024 * 1024;

interface FieldView {
  key: string;
  label: string;
  value: string | number | null;
  confidence: number;
  requiresVerification: boolean;
  hint: string | null;
}

/**
 * The facts the user actually confirmed.
 *
 * A field the user edited but did not tick is deliberately left out: the whole
 * point of the verification step is that nothing becomes a fact until someone
 * says so. Values are parsed back into the types the engines expect, and
 * anything that will not parse is treated as unconfirmed rather than guessed.
 */
export function collectVerifiedFacts(
  values: Record<string, string>,
  confirmed: Record<string, boolean>,
  noticeType: VerifiedFacts['noticeType'],
): VerifiedFacts {
  const confirmedValue = (key: string): string | undefined => {
    if (!confirmed[key]) return undefined;
    const raw = (values[key] ?? '').trim();
    return raw === '' ? undefined : raw;
  };

  const pence = (key: string): number | undefined => {
    const raw = confirmedValue(key);
    if (raw === undefined) return undefined;
    const digits = raw.replace(/[£,\s]/g, '');
    return /^\d+$/.test(digits) ? Number(digits) : undefined;
  };

  const date = (key: string): string | undefined => {
    const raw = confirmedValue(key);
    return raw !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : undefined;
  };

  return {
    noticeType,
    authorityName: confirmedValue('authorityName'),
    pcnNumber: confirmedValue('pcnNumber'),
    vehicleRegistration: confirmedValue('vehicleRegistration'),
    contraventionCode: confirmedValue('contraventionCode'),
    contraventionDescription: confirmedValue('contraventionDescription'),
    incidentDate: date('incidentDate'),
    incidentTime: (() => {
      const raw = confirmedValue('incidentTime');
      return raw !== undefined && /^\d{2}:\d{2}$/.test(raw) ? raw : undefined;
    })(),
    issueDate: date('issueDate'),
    location: confirmedValue('location'),
    fullAmountPence: pence('fullAmountPence'),
    discountedAmountPence: pence('discountedAmountPence'),
    discountDeadlinePrinted: date('discountDeadlinePrinted'),
    representationDeadlinePrinted: date('representationDeadlinePrinted'),
  };
}

type Step =
  | { kind: 'UPLOAD' }
  | { kind: 'READING' }
  | { kind: 'VERIFY'; fields: FieldView[]; legibility: string; unreadable: string[] }
  | { kind: 'OUT_OF_SCOPE'; message: string; explanation: string }
  | { kind: 'MANUAL' }
  | { kind: 'ERROR'; what: string; whatYouCanDo: string; dataSaved: boolean; reference?: string }
  | { kind: 'ANALYSING' }
  | { kind: 'ASSESSED'; assessment: VerifiedAssessment; facts: VerifiedFacts }
  // The assessment failed. The confirmed facts are held so nothing the user
  // typed is lost, and so the attempt can be repeated.
  | { kind: 'ASSESSMENT_FAILED'; facts: VerifiedFacts; message: string };

export function AnalyseFlow({ extractionAvailable }: { extractionAvailable: boolean }) {
  const [step, setStep] = useState<Step>({ kind: 'UPLOAD' });

  /**
   * Turns the confirmed fields into the assessment.
   *
   * Only what the user ticked is sent. An edited-but-unconfirmed value never
   * leaves this function, so it cannot reach a deadline or a finding.
   */
  const runAssessment = useCallback(async (facts: VerifiedFacts) => {
    setStep({ kind: 'ANALYSING' });
    try {
      const response = await fetch('/api/cases/assess', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(facts),
      });
      const body = (await response.json()) as
        | { ok: true; assessment: VerifiedAssessment }
        | { ok: false; reason: string };

      if (!body.ok) {
        setStep({
          kind: 'ASSESSMENT_FAILED',
          facts,
          message:
            body.reason === 'RATE_LIMITED'
              ? 'Too many requests just now. Wait a moment and try again.'
              : 'We could not put your assessment together just now.',
        });
        return;
      }
      setStep({ kind: 'ASSESSED', assessment: body.assessment, facts });
    } catch {
      setStep({
        kind: 'ASSESSMENT_FAILED',
        facts,
        message: 'We could not reach the assessment service.',
      });
    }
  }, []);
  const [values, setValues] = useState<Record<string, string>>({});
  /**
   * What the reader made of the notice type.
   *
   * Kept here rather than on the step, because the step changes and this must
   * not. It lived inside the VERIFY step and was lost the moment the user
   * pressed "Check the details we read", which moves to MANUAL — so a
   * re-confirmed Westminster PCN came back as an unidentifiable document.
   *
   * It is a starting point, not a verdict: the assessment re-derives the
   * category from this *and* the authority name on every request, so editing
   * the authority reclassifies the notice properly.
   */
  const [readNoticeType, setReadNoticeType] =
    useState<VerifiedFacts['noticeType']>('UNKNOWN');
  /**
   * The read itself, kept so "Edit verified details" can return to it.
   *
   * Editing used to drop to the manual form, which lists seven fields against
   * the fourteen the reader fills in — so the registration, the times and the
   * printed deadlines vanished from view while still being sent. Going back to
   * the verification step keeps every field, its confidence and its hint.
   */
  const [verifySnapshot, setVerifySnapshot] = useState<{
    fields: FieldView[];
    legibility: string;
    unreadable: string[];
  } | null>(null);

  /** Back to the read when there was one, otherwise the manual form. */
  const editDetails = useCallback(() => {
    setStep(verifySnapshot ? { kind: 'VERIFY', ...verifySnapshot } : { kind: 'MANUAL' });
  }, [verifySnapshot]);
  const [confirmed, setConfirmed] = useState<Record<string, boolean>>({});
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);

  const onFile = useCallback(
    async (file: File) => {
      if (!ACCEPTED_TYPES.includes(file.type)) {
        setStep({
          kind: 'ERROR',
          what: `We cannot read ${file.type || 'that file type'}.`,
          whatYouCanDo: 'Upload a JPG, PNG or PDF of your notice.',
          dataSaved: false,
        });
        return;
      }
      if (file.size > MAX_BYTES) {
        setStep({
          kind: 'ERROR',
          what: `That file is ${(file.size / 1024 / 1024).toFixed(1)}MB, which is larger than we accept.`,
          whatYouCanDo: 'Take the photo again at a lower resolution, or upload a smaller file.',
          dataSaved: false,
        });
        return;
      }

      setStep({ kind: 'READING' });

      try {
        const body = new FormData();
        body.append('file', file);
        const response = await fetch('/api/cases/extract', { method: 'POST', body });
        const result = await response.json();

        if (result.kind === 'EXTRACTED') {
          const fields = result.fields as FieldView[];
          setValues(
            Object.fromEntries(fields.map((f) => [f.key, f.value === null ? '' : String(f.value)])),
          );
          setConfirmed({});
          // Reported separately from the editable fields, so it has to be
          // carried separately too.
          setReadNoticeType(result.noticeType as VerifiedFacts['noticeType']);
          const snapshot = {
            fields,
            legibility: result.legibility,
            unreadable: result.unreadableRegions ?? [],
          };
          setVerifySnapshot(snapshot);
          setStep({ kind: 'VERIFY', ...snapshot });
        } else if (result.kind === 'OUT_OF_SCOPE') {
          setStep({
            kind: 'OUT_OF_SCOPE',
            message: result.message,
            explanation: result.explanation,
          });
        } else {
          setStep({
            kind: 'ERROR',
            what: result.what ?? 'We could not read the notice.',
            whatYouCanDo:
              result.whatYouCanDo ?? 'Nothing has been saved. You can enter the details by hand.',
            dataSaved: result.dataSaved ?? false,
            reference: result.correlationId,
          });
        }
      } catch {
        setStep({
          kind: 'ERROR',
          what: 'The upload did not complete.',
          whatYouCanDo:
            'Nothing has been saved. Check your connection and try again, or enter the details by hand.',
          dataSaved: false,
        });
      }
    },
    [],
  );

  /* ---------------------------------------------------------------- */

  if (step.kind === 'UPLOAD') {
    return (
      <div style={{ marginTop: 28 }}>
        {!extractionAvailable && (
          <Notice tone="warn">
            <strong>Automatic reading is not available on this deployment.</strong> You can still
            enter your notice details by hand and everything else works normally.
          </Notice>
        )}

        <div
          style={{
            marginTop: 20,
            border: '2px dashed var(--border-strong)',
            borderRadius: 'var(--radius-lg)',
            padding: '32px 20px',
            textAlign: 'center',
            background: 'var(--surface-sunken)',
          }}
        >
          <p style={{ margin: '0 0 20px', fontSize: 15, color: 'var(--text-muted)' }}>
            Photograph the whole notice, flat, with all four corners visible.
          </p>

          <div
            style={{
              display: 'flex',
              gap: 10,
              justifyContent: 'center',
              flexWrap: 'wrap',
            }}
          >
            {/* Camera first: this is what someone standing by their car needs. */}
            <button
              type="button"
              onClick={() => cameraRef.current?.click()}
              className="fr-touch"
              disabled={!extractionAvailable}
              style={primaryButton(extractionAvailable)}
            >
              Take a photo
            </button>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="fr-touch"
              disabled={!extractionAvailable}
              style={secondaryButton(extractionAvailable)}
            >
              Choose a file
            </button>
          </div>

          <input
            ref={cameraRef}
            type="file"
            accept="image/*"
            capture="environment"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void onFile(file);
            }}
          />
          <input
            ref={fileRef}
            type="file"
            accept={ACCEPTED_TYPES.join(',')}
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void onFile(file);
            }}
          />

          <p style={{ margin: '18px 0 0', fontSize: 12.5, color: 'var(--text-faint)' }}>
            JPG, PNG or PDF, up to 12MB. Your document is stored privately and only you can read it.
          </p>
        </div>

        <p style={{ marginTop: 18, fontSize: 14.5 }}>
          <button
            type="button"
            onClick={() => setStep({ kind: 'MANUAL' })}
            style={linkButton}
          >
            Enter the details by hand instead →
          </button>
        </p>

        <CaptureTips />
      </div>
    );
  }

  if (step.kind === 'READING') {
    return (
      <div style={{ marginTop: 40, textAlign: 'center' }} role="status" aria-live="polite">
        <p style={{ fontSize: 16, fontWeight: 550 }}>Reading your notice…</p>
        <p style={{ fontSize: 14, color: 'var(--text-muted)' }}>
          This usually takes a few seconds. You will be asked to check everything we read.
        </p>
      </div>
    );
  }

  if (step.kind === 'OUT_OF_SCOPE') {
    return (
      <div style={{ marginTop: 28 }}>
        <Notice tone="warn">
          <strong>{step.message}</strong>
          <p style={{ margin: '8px 0 0', fontSize: 14 }}>{step.explanation}</p>
        </Notice>
        <p style={{ marginTop: 18, fontSize: 14.5, color: 'var(--text-muted)', maxWidth: 600 }}>
          A private parking charge is a claim under contract law, not a penalty issued under the
          Traffic Management Act. The deadlines, the grounds you can rely on and the appeal route
          are all different, so applying our council rules to it would give you wrong answers.
        </p>
        <p style={{ marginTop: 18 }}>
          <button type="button" onClick={() => setStep({ kind: 'UPLOAD' })} style={linkButton}>
            ← Upload a different notice
          </button>
        </p>
      </div>
    );
  }

  if (step.kind === 'ERROR') {
    return (
      <div style={{ marginTop: 28 }}>
        <Notice tone="error">
          <strong>{step.what}</strong>
          <p style={{ margin: '8px 0 0', fontSize: 14 }}>
            {step.dataSaved
              ? 'Your upload was saved and you can come back to it.'
              : 'Nothing was saved.'}{' '}
            {step.whatYouCanDo}
          </p>
          {step.reference && (
            <p style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--text-faint)' }}>
              Reference {step.reference}
            </p>
          )}
        </Notice>
        <div style={{ display: 'flex', gap: 10, marginTop: 18, flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={() => setStep({ kind: 'UPLOAD' })}
            className="fr-touch"
            style={secondaryButton(true)}
          >
            Try again
          </button>
          <button
            type="button"
            onClick={() => setStep({ kind: 'MANUAL' })}
            className="fr-touch"
            style={primaryButton(true)}
          >
            Enter details by hand
          </button>
        </div>
      </div>
    );
  }

  if (step.kind === 'MANUAL' || step.kind === 'VERIFY') {
    const fields: FieldView[] =
      step.kind === 'VERIFY'
        ? step.fields
        : MANUAL_FIELDS.map((f) => ({ ...f, value: null, confidence: 1, requiresVerification: true, hint: null }));

    const outstanding = fields.filter((f) => f.requiresVerification && !confirmed[f.key]);

    return (
      <div style={{ marginTop: 28 }}>
        {step.kind === 'VERIFY' && (
          <>
            <Notice tone={step.legibility === 'POOR' ? 'warn' : 'neutral'}>
              <strong>Check what we read.</strong>
              <p style={{ margin: '6px 0 0', fontSize: 14 }}>
                {step.legibility === 'POOR'
                  ? 'The photo was hard to read, so please check every field carefully against your notice.'
                  : 'Nothing below is treated as correct until you confirm it. The fields that set your deadlines are always checked, however clear the photo was.'}
              </p>
            </Notice>
            {step.unreadable.length > 0 && (
              <p style={{ marginTop: 12, fontSize: 13.5, color: 'var(--text-muted)' }}>
                We could not read: {step.unreadable.join('; ')}.
              </p>
            )}
          </>
        )}

        <form
          style={{ marginTop: 20, display: 'grid', gap: 14 }}
          onSubmit={(e) => {
            e.preventDefault();
            void runAssessment(collectVerifiedFacts(values, confirmed, readNoticeType));
          }}
        >
          {fields.map((field) => (
            <VerifyField
              key={field.key}
              field={field}
              value={values[field.key] ?? ''}
              confirmed={confirmed[field.key] ?? false}
              onChange={(v) => setValues((prev) => ({ ...prev, [field.key]: v }))}
              onConfirm={(v) => setConfirmed((prev) => ({ ...prev, [field.key]: v }))}
            />
          ))}

          <div
            style={{
              position: 'sticky',
              bottom: 0,
              background: 'var(--surface)',
              paddingTop: 14,
              paddingBottom: 14,
              borderTop: '1px solid var(--border)',
              marginTop: 8,
            }}
          >
            <button
              type="submit"
              className="fr-touch"
              disabled={outstanding.length > 0}
              style={primaryButton(outstanding.length === 0, true)}
            >
              {outstanding.length > 0
                ? `Confirm ${outstanding.length} more field${outstanding.length === 1 ? '' : 's'}`
                : // Nothing is stored, so the button must not say it is.
                  'Confirm and continue'}
            </button>
            {outstanding.length > 0 && (
              <p style={{ margin: '8px 0 0', fontSize: 12.5, color: 'var(--text-faint)' }}>
                We will not calculate a deadline from a field you have not checked.
              </p>
            )}
          </div>
        </form>
      </div>
    );
  }

  if (step.kind === 'ANALYSING') {
    return (
      <div style={{ marginTop: 28 }} role="status" aria-live="polite">
        <Notice tone="neutral">
          <strong>Analysing your verified PCN…</strong>
          <p style={{ margin: '6px 0 0', fontSize: 14 }}>
            Checking the contravention against our reference data and working out your dates.
          </p>
        </Notice>
      </div>
    );
  }

  if (step.kind === 'ASSESSMENT_FAILED') {
    // The confirmed facts are still held in state, so nothing the user typed
    // is lost and the attempt can simply be repeated.
    return (
      <div style={{ marginTop: 28 }}>
        <Notice tone="warn">
          <strong>{step.message}</strong>
          <p style={{ margin: '6px 0 0', fontSize: 14 }}>
            The details you confirmed have not been lost. You can try again, or go back and change
            them.
          </p>
        </Notice>
        <div style={{ marginTop: 16, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button
            type="button"
            className="fr-touch"
            onClick={() => void runAssessment(step.facts)}
            style={primaryButton(true)}
          >
            Try again
          </button>
          <button
            type="button"
            className="fr-touch"
            onClick={editDetails}
            style={secondaryButton(true)}
          >
            Change the details
          </button>
        </div>
      </div>
    );
  }

  return (
    <AssessmentView
      result={step.assessment}
      facts={step.facts}
      onEdit={editDetails}
    />
  );
}

/* ------------------------------------------------------------------ */

function VerifyField({
  field,
  value,
  confirmed,
  onChange,
  onConfirm,
}: {
  field: FieldView;
  value: string;
  confirmed: boolean;
  onChange: (v: string) => void;
  onConfirm: (v: boolean) => void;
}) {
  const id = useId();
  const lowConfidence = field.confidence < 0.85;

  return (
    <div
      className="fr-panel"
      style={{
        padding: 14,
        borderColor: field.requiresVerification && !confirmed ? 'var(--color-warn)' : 'var(--border)',
      }}
    >
      <label htmlFor={id} style={{ display: 'block', fontSize: 13.5, fontWeight: 600, marginBottom: 6 }}>
        {field.label}
        {lowConfidence && (
          <span style={{ marginLeft: 8, fontSize: 11.5, fontWeight: 500, color: 'var(--color-warn)' }}>
            hard to read
          </span>
        )}
      </label>
      <input
        id={id}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          // Editing a value un-confirms it: the user must look at what they typed.
          onConfirm(false);
        }}
        className="fr-touch"
        inputMode={field.key.includes('Amount') ? 'decimal' : 'text'}
        style={{
          width: '100%',
          padding: '0 12px',
          border: '1px solid var(--border-strong)',
          borderRadius: 'var(--radius-md)',
          background: 'var(--surface)',
          color: 'var(--text)',
          fontSize: 16,
        }}
        placeholder={field.value === null ? 'Not found — type it from your notice' : undefined}
      />
      {field.requiresVerification && (
        <label
          className="fr-touch"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 9,
            marginTop: 9,
            fontSize: 13.5,
            cursor: 'pointer',
          }}
        >
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => onConfirm(e.target.checked)}
            style={{ width: 19, height: 19 }}
          />
          This matches my notice
        </label>
      )}
    </div>
  );
}

const MANUAL_FIELDS = [
  { key: 'authorityName', label: 'Issuing authority' },
  { key: 'pcnNumber', label: 'PCN number' },
  { key: 'contraventionCode', label: 'Contravention code' },
  { key: 'incidentDate', label: 'Date of the alleged contravention (YYYY-MM-DD)' },
  { key: 'issueDate', label: 'Date the notice was issued (YYYY-MM-DD)' },
  { key: 'location', label: 'Location' },
  { key: 'fullAmountPence', label: 'Full amount' },
] as const;

function CaptureTips() {
  const pcn = EVIDENCE_DEFINITIONS.PCN_IMAGE;
  return (
    <div style={{ marginTop: 28, paddingTop: 20, borderTop: '1px solid var(--border)' }}>
      <div className="fr-eyebrow" style={{ marginBottom: 8 }}>
        Getting a usable photo
      </div>
      <p style={{ margin: 0, fontSize: 14, color: 'var(--text-muted)', maxWidth: 560 }}>
        {pcn.howToCapture} {pcn.whyItMatters}
      </p>
    </div>
  );
}

function Notice({
  tone,
  children,
}: {
  tone: 'neutral' | 'ok' | 'warn' | 'error';
  children: React.ReactNode;
}) {
  const colour = {
    neutral: 'var(--border-strong)',
    ok: 'var(--color-ok)',
    warn: 'var(--color-warn)',
    error: 'var(--color-urgent)',
  }[tone];

  return (
    <div
      role="status"
      style={{
        border: `1px solid ${colour}`,
        background: `color-mix(in srgb, ${colour} 8%, transparent)`,
        borderRadius: 'var(--radius-md)',
        padding: '13px 15px',
        fontSize: 14.5,
      }}
    >
      {children}
    </div>
  );
}

function primaryButton(enabled: boolean, fullWidth = false): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: fullWidth ? '100%' : undefined,
    padding: '0 22px',
    background: enabled ? 'var(--color-ink-900)' : 'var(--color-ink-300)',
    color: enabled ? 'var(--color-ink-50)' : 'var(--color-ink-500)',
    border: 'none',
    borderRadius: 'var(--radius-md)',
    fontSize: 15,
    fontWeight: 550,
    cursor: enabled ? 'pointer' : 'not-allowed',
  };
}

function secondaryButton(enabled: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '0 22px',
    background: 'transparent',
    color: enabled ? 'var(--text)' : 'var(--text-faint)',
    border: '1px solid var(--border-strong)',
    borderRadius: 'var(--radius-md)',
    fontSize: 15,
    fontWeight: 550,
    cursor: enabled ? 'pointer' : 'not-allowed',
  };
}

const linkButton: React.CSSProperties = {
  background: 'none',
  border: 'none',
  padding: 0,
  color: 'var(--color-signal-600)',
  cursor: 'pointer',
  fontSize: 'inherit',
  textDecoration: 'underline',
};
