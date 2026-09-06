'use client';

import { useMemo, useState } from 'react';
import { selectContextQuestions } from '@/core/context/questions';
import type {
  AnswerValue,
  EvidenceHeld,
  UserContext,
} from '@/core/context/types';
import type { EvidenceType } from '@/core/evidence/types';
import type { NoticeType, ProceduralStage } from '@/core/reference/types';

/**
 * "Tell us what happened" — the stage between confirming the notice and the
 * assessment.
 *
 * Up to here PCNWatch could only say what the authority alleges. Nothing the
 * user knows about their own case had anywhere to go, so a permit in a drawer
 * and a genuine mistake produced identical output. This is where that changes.
 *
 * Three things it is careful about:
 *
 *  - The narrative never leaves the browser. It may contain a name, an address
 *    or a medical detail; no deterministic rule can read prose anyway, and
 *    there is no authenticated case to store it against yet. What crosses to
 *    the server is the fact that an account exists, plus answers drawn from a
 *    closed set.
 *  - Questions are not defences. Answering "yes" records a claim. It does not
 *    assert a statutory ground and nothing downstream treats it as one.
 *  - Everything is skippable. A user who does not want to type gets an
 *    assessment that says plainly why it is limited, rather than a worse one
 *    dressed up as complete.
 */

const ANSWERS: readonly { value: AnswerValue; label: string }[] = [
  { value: 'YES', label: 'Yes' },
  { value: 'NO', label: 'No' },
  { value: 'UNSURE', label: 'Not sure' },
];

const HELD: readonly { value: EvidenceHeld; label: string }[] = [
  { value: 'HAVE', label: 'I have this' },
  { value: 'DO_NOT_HAVE', label: 'I do not' },
  { value: 'NOT_SURE', label: 'Not sure' },
];

export interface ContextDraft {
  narrative: string;
  answers: Record<string, AnswerValue>;
  evidence: Partial<Record<EvidenceType, EvidenceHeld>>;
}

export const EMPTY_CONTEXT_DRAFT: ContextDraft = { narrative: '', answers: {}, evidence: {} };

/**
 * Turns what the user filled in into what the server is allowed to see.
 *
 * The narrative becomes a boolean here and nowhere else. Everything that
 * survives this function is either a reference-store question id, one of three
 * answers, or an evidence type from a fixed list.
 */
export function toUserContext(draft: ContextDraft): UserContext {
  return {
    narrativeProvided: draft.narrative.trim().length > 0,
    answers: Object.entries(draft.answers).map(([questionId, answer]) => ({ questionId, answer })),
    declaredEvidence: Object.entries(draft.evidence).map(([type, held]) => ({
      type: type as EvidenceType,
      held: held as EvidenceHeld,
    })),
  };
}

export function ContextStage({
  contraventionCode,
  noticeType,
  proceduralStage,
  draft,
  onChange,
  onBack,
  onSubmit,
  onSkip,
}: {
  contraventionCode: string | null;
  noticeType: NoticeType;
  proceduralStage: ProceduralStage;
  draft: ContextDraft;
  onChange: (next: ContextDraft) => void;
  onBack: () => void;
  onSubmit: () => void;
  onSkip: () => void;
}) {
  // Two panels rather than one long form: the open question first, then the
  // specifics. On a phone the whole of step one fits above the fold.
  const [panel, setPanel] = useState<'ACCOUNT' | 'DETAIL'>('ACCOUNT');
  const [evidenceOpen, setEvidenceOpen] = useState(false);

  const questionSet = useMemo(
    () => selectContextQuestions({ contraventionCode, noticeType, proceduralStage }),
    [contraventionCode, noticeType, proceduralStage],
  );

  if (panel === 'ACCOUNT') {
    return (
      <div style={{ marginTop: 28 }}>
        <div className="fr-eyebrow" style={{ marginBottom: 6 }}>
          Step 3 of 4 — your account
        </div>
        <h2 style={{ fontSize: 20, fontWeight: 640, margin: '0 0 8px' }}>What happened?</h2>
        <p style={{ margin: '0 0 4px', fontSize: 14.5, color: 'var(--text-muted)', lineHeight: 1.5 }}>
          Tell us what happened in your own words. Include anything you think matters, such as
          permits, payment, loading, signs, road markings, breakdowns or mistakes.
        </p>
        <p style={{ margin: '0 0 14px', fontSize: 13.5, color: 'var(--text-faint)' }}>
          Write it however you like. You do not need legal wording — that is our job, not yours.
        </p>

        <label htmlFor="what-happened" style={{ display: 'none' }}>
          What happened?
        </label>
        <textarea
          id="what-happened"
          value={draft.narrative}
          onChange={(e) => onChange({ ...draft, narrative: e.target.value })}
          rows={7}
          placeholder="For example: I had a resident's permit for that bay and had just renewed it that morning…"
          style={{
            width: '100%',
            boxSizing: 'border-box',
            padding: '12px 14px',
            fontSize: 16, // 16px or larger stops iOS zooming the page on focus.
            lineHeight: 1.5,
            fontFamily: 'inherit',
            border: '1px solid var(--border-strong)',
            borderRadius: 'var(--radius-md)',
            background: 'var(--surface)',
            color: 'var(--text)',
            resize: 'vertical',
          }}
        />

        <SessionOnlyNote />

        <div style={{ marginTop: 18, display: 'grid', gap: 10 }}>
          <button
            type="button"
            className="fr-touch"
            onClick={() => setPanel('DETAIL')}
            style={primary(true)}
          >
            Continue
          </button>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button type="button" className="fr-touch" onClick={onBack} style={secondary}>
              Back to your details
            </button>
            <button type="button" className="fr-touch" onClick={onSkip} style={secondary}>
              Skip for now
            </button>
          </div>
        </div>
      </div>
    );
  }

  const answeredCount = Object.keys(draft.answers).length;

  return (
    <div style={{ marginTop: 28 }}>
      <div className="fr-eyebrow" style={{ marginBottom: 6 }}>
        Step 3 of 4 — a few specifics
      </div>
      <h2 style={{ fontSize: 20, fontWeight: 640, margin: '0 0 8px' }}>
        {questionSet.questions.length > 0
          ? 'A few things that often matter here'
          : 'A few general questions'}
      </h2>
      <p style={{ margin: '0 0 4px', fontSize: 14.5, color: 'var(--text-muted)', lineHeight: 1.5 }}>
        These are questions of fact about your case. Answer what you can and leave the rest —
        every one is optional.
      </p>
      <p style={{ margin: '0 0 16px', fontSize: 13, color: 'var(--text-faint)', lineHeight: 1.5 }}>
        Answering “yes” to any of these does not mean you have a defence. They tell us what is
        worth checking and what evidence would support what you have said.
      </p>

      {questionSet.unknownContraventionCode && (
        <div style={noteBox}>
          PCNWatch does not hold a reference record for code{' '}
          {questionSet.unknownContraventionCode}, so we are not asking questions specific to it.
          We would rather ask nothing than invent the wrong questions.
        </div>
      )}

      <div style={{ display: 'grid', gap: 12 }}>
        {questionSet.questions.map((question) => (
          <fieldset key={question.id} style={card}>
            <legend style={{ fontSize: 14.5, fontWeight: 550, padding: 0, lineHeight: 1.45 }}>
              {question.prompt}
            </legend>
            {question.isMitigation && (
              <p style={{ margin: '6px 0 0', fontSize: 12.5, color: 'var(--text-faint)' }}>
                This asks the authority to use its discretion. It is not a legal ground and does
                not say the contravention did not happen.
              </p>
            )}
            <div style={choiceRow}>
              {ANSWERS.map((option) => (
                <Choice
                  key={option.value}
                  name={question.id}
                  label={option.label}
                  selected={draft.answers[question.id] === option.value}
                  onSelect={() =>
                    onChange({
                      ...draft,
                      answers: { ...draft.answers, [question.id]: option.value },
                    })
                  }
                />
              ))}
            </div>
          </fieldset>
        ))}
      </div>

      {questionSet.evidenceQuestions.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <button
            type="button"
            className="fr-touch"
            aria-expanded={evidenceOpen}
            onClick={() => setEvidenceOpen((open) => !open)}
            style={{ ...secondary, width: '100%', justifyContent: 'space-between' }}
          >
            <span>Do you have anything that supports this?</span>
            <span aria-hidden="true">{evidenceOpen ? '−' : '+'}</span>
          </button>

          {evidenceOpen && (
            <div style={{ marginTop: 12, display: 'grid', gap: 12 }}>
              <p style={{ margin: 0, fontSize: 13, color: 'var(--text-faint)', lineHeight: 1.5 }}>
                Just tell us what exists — there is nothing to upload yet. Saying you have
                something does not make your case stronger on its own; it tells us what to ask
                you for.
              </p>
              {questionSet.evidenceQuestions.map((item) => (
                <fieldset key={item.type} style={card}>
                  <legend style={{ fontSize: 14.5, fontWeight: 550, padding: 0 }}>
                    {item.label}
                  </legend>
                  <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--text-muted)' }}>
                    {item.reason}
                  </p>
                  <div style={choiceRow}>
                    {HELD.map((option) => (
                      <Choice
                        key={option.value}
                        name={`evidence-${item.type}`}
                        label={option.label}
                        selected={draft.evidence[item.type] === option.value}
                        onSelect={() =>
                          onChange({
                            ...draft,
                            evidence: { ...draft.evidence, [item.type]: option.value },
                          })
                        }
                      />
                    ))}
                  </div>
                </fieldset>
              ))}
            </div>
          )}
        </div>
      )}

      <SessionOnlyNote />

      <div
        style={{
          position: 'sticky',
          bottom: 0,
          background: 'var(--surface)',
          borderTop: '1px solid var(--border)',
          paddingTop: 14,
          paddingBottom: 14,
          marginTop: 18,
          display: 'grid',
          gap: 10,
        }}
      >
        <button type="button" className="fr-touch" onClick={onSubmit} style={primary(true)}>
          See my assessment
        </button>
        <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-faint)' }}>
          {answeredCount === 0
            ? 'You have not answered any of these. Your assessment will say what it could not take into account.'
            : `Using ${answeredCount} answer${answeredCount === 1 ? '' : 's'} and what you told us.`}
        </p>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button
            type="button"
            className="fr-touch"
            onClick={() => setPanel('ACCOUNT')}
            style={secondary}
          >
            Back to what happened
          </button>
          <button type="button" className="fr-touch" onClick={onBack} style={secondary}>
            Back to your details
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * A radio in everything but appearance.
 *
 * Radios rather than buttons because a screen reader should announce these as
 * one choice out of three, and because a user can change their mind by moving
 * within the group rather than hunting for a way to clear a pressed button.
 */
function Choice({
  name,
  label,
  selected,
  onSelect,
}: {
  name: string;
  label: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <label
      className="fr-touch"
      style={{
        flex: '1 1 0',
        minWidth: 88,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        padding: '0 10px',
        textAlign: 'center',
        fontSize: 14,
        fontWeight: selected ? 620 : 500,
        cursor: 'pointer',
        borderRadius: 'var(--radius-md)',
        border: `1px solid ${selected ? 'var(--text)' : 'var(--border-strong)'}`,
        background: selected ? 'var(--surface-raised)' : 'var(--surface)',
      }}
    >
      <input
        type="radio"
        name={name}
        checked={selected}
        onChange={onSelect}
        style={{ position: 'absolute', opacity: 0, width: 1, height: 1 }}
      />
      {label}
    </label>
  );
}

/** Says what happens to what the user just typed. Shown on both panels. */
function SessionOnlyNote() {
  return (
    <p
      style={{
        margin: '14px 0 0',
        fontSize: 12.5,
        color: 'var(--text-faint)',
        lineHeight: 1.5,
      }}
    >
      What you write here stays in this browser for this session only. It is not sent to our
      servers, not saved to an account, and it is gone when you close the page.
    </p>
  );
}

const card: React.CSSProperties = {
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-md)',
  padding: '12px 14px',
  margin: 0,
  background: 'var(--surface-raised)',
  minWidth: 0,
};

const choiceRow: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  marginTop: 10,
  flexWrap: 'wrap',
};

const noteBox: React.CSSProperties = {
  border: '1px solid var(--border-strong)',
  borderRadius: 'var(--radius-md)',
  padding: '12px 14px',
  marginBottom: 16,
  fontSize: 13.5,
  lineHeight: 1.5,
  color: 'var(--text-muted)',
};

function primary(enabled: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    padding: '0 18px',
    border: '1px solid var(--text)',
    borderRadius: 'var(--radius-md)',
    background: 'var(--text)',
    color: 'var(--surface)',
    fontSize: 15.5,
    fontWeight: 600,
    cursor: enabled ? 'pointer' : 'not-allowed',
    opacity: enabled ? 1 : 0.5,
  };
}

const secondary: React.CSSProperties = {
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
