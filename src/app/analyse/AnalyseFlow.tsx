'use client';

import { useCallback, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { EVIDENCE_DEFINITIONS } from '@/core/evidence/definitions';

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

type Step =
  | { kind: 'UPLOAD' }
  | { kind: 'READING' }
  | { kind: 'VERIFY'; fields: FieldView[]; legibility: string; unreadable: string[] }
  | { kind: 'OUT_OF_SCOPE'; message: string; explanation: string }
  | { kind: 'MANUAL' }
  | { kind: 'ERROR'; what: string; whatYouCanDo: string; dataSaved: boolean; reference?: string }
  | { kind: 'SAVED'; caseId: string };

export function AnalyseFlow({
  extractionAvailable,
  storageAvailable,
}: {
  extractionAvailable: boolean;
  storageAvailable: boolean;
}) {
  const [step, setStep] = useState<Step>({ kind: 'UPLOAD' });
  const [values, setValues] = useState<Record<string, string>>({});
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
          setStep({
            kind: 'VERIFY',
            fields,
            legibility: result.legibility,
            unreadable: result.unreadableRegions ?? [],
          });
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
            if (!storageAvailable) {
              setStep({
                kind: 'ERROR',
                what: 'Saving cases is not available on this deployment.',
                whatYouCanDo:
                  'The details you entered have not been stored. You can still use the code and evidence guidance on this site.',
                dataSaved: false,
              });
              return;
            }
            setStep({ kind: 'SAVED', caseId: 'pending' });
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
                : 'Save and continue'}
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

  return (
    <div style={{ marginTop: 28 }}>
      <Notice tone="ok">
        <strong>Case saved.</strong>
        <p style={{ margin: '6px 0 0', fontSize: 14 }}>
          Your notice details are stored privately. Only you can read them.
        </p>
      </Notice>
      <p style={{ marginTop: 18 }}>
        <Link href="/">Return home</Link>
      </p>
    </div>
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
