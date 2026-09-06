import { describe, expect, it } from 'vitest';
import { assessVerifiedNotice, type VerifiedFacts } from '@/server/cases/assess-verified';
import { EMPTY_USER_CONTEXT, type UserContext } from '@/core/context/types';
import { POST } from '@/app/api/cases/assess/route';
import {
  confirmedAssertionsOf,
  toUserContext,
  EMPTY_CONTEXT_DRAFT,
  type ContextDraft,
} from '@/app/analyse/ContextStage';

/**
 * The boundary between what a model read and what a user confirmed.
 *
 * An extracted assertion is a machine's reading of somebody's prose. A
 * confirmed one is a person saying that reading is right. Only the second may
 * influence an assessment, and these cover what happens when something tries to
 * cross that line — a stale client, a hand-made request, or simply a user who
 * looked at our reading and did not agree with it.
 */

const WESTMINSTER: VerifiedFacts = {
  noticeType: 'PCN_POSTAL',
  authorityName: 'Westminster City Council',
  contraventionCode: '12',
  incidentDate: '2026-08-11',
  issueDate: '2026-08-14',
  location: 'Gloucester Place',
  fullAmountPence: 13000,
};

function context(over: Partial<UserContext> = {}): UserContext {
  return { ...EMPTY_USER_CONTEXT, narrativeProvided: true, ...over };
}

function draft(over: Partial<ContextDraft> = {}): ContextDraft {
  return { ...EMPTY_CONTEXT_DRAFT, ...over };
}

const EXTRACTED = [
  {
    kind: 'HELD_PERMIT' as const,
    stance: 'ASSERTED' as const,
    confidence: 0.9,
    summary: 'Says a resident permit was held.',
    source: 'USER_ACCOUNT' as const,
  },
  {
    kind: 'PAYMENT_BY_APP' as const,
    stance: 'ASSERTED' as const,
    confidence: 0.8,
    summary: 'Says payment was made by app.',
    source: 'USER_ACCOUNT' as const,
  },
];

describe('an extraction is not a fact until the user says so', () => {
  it('sends nothing to the assessment while the user has decided nothing', () => {
    // The whole extraction sitting in the draft, unreviewed. This is the state
    // the confirmation screen is showing, and it must carry no weight at all.
    const unreviewed = draft({ narrative: 'I had a permit.', extracted: EXTRACTED });

    expect(confirmedAssertionsOf(unreviewed)).toEqual([]);
    expect(toUserContext(unreviewed).confirmedAssertions).toEqual([]);
  });

  it('sends only what the user confirmed, not everything we read', () => {
    const partly = draft({
      narrative: 'I had a permit.',
      extracted: EXTRACTED,
      decisions: {
        HELD_PERMIT: { confirmed: true, stance: 'ASSERTED' },
        PAYMENT_BY_APP: { confirmed: false },
      },
    });

    expect(toUserContext(partly).confirmedAssertions).toEqual([
      { kind: 'HELD_PERMIT', stance: 'ASSERTED' },
    ]);
  });

  it('lets the user correct our reading rather than only accept it', () => {
    // We read "held a permit"; they say the opposite. A confirmation screen
    // where disagreeing is impossible is not a confirmation screen.
    const corrected = draft({
      extracted: EXTRACTED,
      decisions: { HELD_PERMIT: { confirmed: true, stance: 'DENIED' } },
    });
    expect(toUserContext(corrected).confirmedAssertions).toEqual([
      { kind: 'HELD_PERMIT', stance: 'DENIED' },
    ]);
  });

  it('produces an identical assessment to one where nothing was read at all', () => {
    const unreviewed = toUserContext(draft({ narrative: 'I had a permit.', extracted: EXTRACTED }));
    const nothingRead = context();

    const a = assessVerifiedNotice(WESTMINSTER, unreviewed);
    const b = assessVerifiedNotice(WESTMINSTER, nothingRead);

    expect(a).toEqual(b);
  });

  it('carries none of the model’s words into the assessment', () => {
    const confirmed = context({
      confirmedAssertions: [{ kind: 'HELD_PERMIT', stance: 'ASSERTED' }],
    });
    const result = assessVerifiedNotice(WESTMINSTER, confirmed);

    // The summary is for the confirmation screen. What reaches the assessment
    // is which fact was confirmed, in our vocabulary — so a model that wrote
    // something careless cannot have written it into a finding.
    const raw = JSON.stringify(result);
    expect(raw).not.toContain('Says a resident permit was held.');
    // Our own label for the fact, not the model's sentence about it.
    expect(raw.toLowerCase()).toContain('you held a permit');
  });
});

describe('a confirmed assertion changes the assessment, within limits', () => {
  it('appears as the user’s account, not as a finding of ours', () => {
    const result = assessVerifiedNotice(
      WESTMINSTER,
      context({ confirmedAssertions: [{ kind: 'HELD_PERMIT', stance: 'ASSERTED' }] }),
    );

    const finding = result.assessment.findings.find((f) => f.id === 'context-user-facts');
    expect(finding).toBeDefined();
    expect(finding!.whyItMayMatter).toMatch(/this is your account rather than a finding of ours/i);
    expect(finding!.category).toBe('FACTUAL_DISPUTE');
    expect(finding!.groundKey).toBeNull();
  });

  it('asks for the evidence that would corroborate it', () => {
    const result = assessVerifiedNotice(
      WESTMINSTER,
      context({
        confirmedAssertions: [
          { kind: 'PAYMENT_BY_APP', stance: 'ASSERTED' },
          { kind: 'SIGNAGE_UNCLEAR_OR_NOT_SEEN', stance: 'ASSERTED' },
        ],
      }),
    );
    const finding = result.assessment.findings.find((f) => f.id === 'context-user-facts');
    expect(finding!.evidenceNeeded).toContain('PARKING_APP_RECEIPT');
    expect(finding!.evidenceNeeded).toContain('PARKING_SIGN');
  });

  it('never asserts a statutory ground, however many facts are confirmed', () => {
    const result = assessVerifiedNotice(
      WESTMINSTER,
      context({
        confirmedAssertions: [
          { kind: 'HELD_PERMIT', stance: 'ASSERTED' },
          { kind: 'PERMIT_VALID', stance: 'ASSERTED' },
          { kind: 'PAYMENT_MADE', stance: 'ASSERTED' },
          { kind: 'BLUE_BADGE_PRESENT', stance: 'ASSERTED' },
        ],
      }),
    );

    // The strongest possible input a user could give. Still no ground: choosing
    // one is a later, deliberate act and never a consequence of describing
    // what happened.
    expect(result.assessment.findingsByCategory.STATUTORY_GROUND).toHaveLength(0);
    expect(result.assessment.findings.every((f) => f.groundKey === null)).toBe(true);
  });

  it('does not become strong evidence on the strength of an account', () => {
    const result = assessVerifiedNotice(
      WESTMINSTER,
      context({
        confirmedAssertions: [
          { kind: 'HELD_PERMIT', stance: 'ASSERTED' },
          { kind: 'PERMIT_VALID', stance: 'ASSERTED' },
        ],
      }),
    );

    expect(result.assessment.basis).not.toBe('STRONG_EVIDENCE_BASIS');
    expect(result.assessment.basis).not.toBe('MODERATE_EVIDENCE_BASIS');
    expect(result.assessment.basisExplanation).toMatch(/rest on your account alone/i);
  });

  it('keeps a breakdown as mitigation rather than as a dispute about the facts', () => {
    const result = assessVerifiedNotice(
      WESTMINSTER,
      context({ confirmedAssertions: [{ kind: 'VEHICLE_BROKE_DOWN', stance: 'ASSERTED' }] }),
    );

    const mitigation = result.assessment.findings.find((f) => f.id === 'context-mitigation');
    expect(mitigation).toBeDefined();
    expect(mitigation!.category).toBe('DISCRETIONARY');
    expect(mitigation!.whyItMayMatter).toMatch(/does not establish that the contravention did not occur/i);
    // And not counted as a factual claim needing corroboration of the usual kind.
    const facts = result.assessment.findings.find((f) => f.id === 'context-user-facts');
    expect(facts).toBeUndefined();
  });

  it('says plainly when something could not be fitted into what it checks', () => {
    const result = assessVerifiedNotice(
      WESTMINSTER,
      context({ confirmedAssertions: [{ kind: 'OTHER_REQUIRES_REVIEW', stance: 'ASSERTED' }] }),
    );

    expect(result.assessment.missingInformation.join(' ')).toMatch(
      /could not fit into the checks we run automatically/i,
    );
    // Not silently dropped, and not silently counted either.
    expect(result.assessment.missingInformation.join(' ')).toMatch(/has also not been assessed/i);
  });

  it('never changes a fact the user verified from the notice', () => {
    const withAssertions = assessVerifiedNotice(
      WESTMINSTER,
      context({
        confirmedAssertions: [
          { kind: 'HELD_PERMIT', stance: 'ASSERTED' },
          { kind: 'PAYMENT_MADE', stance: 'DENIED' },
        ],
      }),
    );
    const without = assessVerifiedNotice(WESTMINSTER, context());

    expect(withAssertions.contravention).toEqual(without.contravention);
    expect(withAssertions.stage).toBe(without.stage);
    expect(withAssertions.authority).toEqual(without.authority);
    expect(withAssertions.printedDeadlines).toEqual(without.printedDeadlines);
    expect(withAssertions.calculatedDeadlines).toEqual(without.calculatedDeadlines);
    expect(withAssertions.refusedDeadlines).toEqual(without.refusedDeadlines);
    expect(withAssertions.amountSummary).toEqual(without.amountSummary);
  });

  it('never states a chance of success', () => {
    const result = assessVerifiedNotice(
      WESTMINSTER,
      context({
        confirmedAssertions: [
          { kind: 'HELD_PERMIT', stance: 'ASSERTED' },
          { kind: 'PERMIT_VALID', stance: 'ASSERTED' },
          { kind: 'MITIGATING_CIRCUMSTANCES', stance: 'ASSERTED' },
        ],
      }),
    );
    const text = JSON.stringify(result).toLowerCase();
    for (const phrase of ['you will win', 'likely to succeed', 'good chance', '% chance', 'you should appeal']) {
      expect(text, `the assessment said "${phrase}"`).not.toContain(phrase);
    }
  });
});

describe('the assess endpoint', () => {
  async function post(body: unknown) {
    const response = await POST(
      new Request('http://localhost/api/cases/assess', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
    return { status: response.status, json: await response.json() };
  }

  it('has no field for an unconfirmed assertion, so none can be sent', async () => {
    // A summary, a confidence and a "confirmed" flag are all absent from the
    // wire shape. There is no way to express an unreviewed extraction here, so
    // nothing downstream has to remember to filter one out.
    const { status, json } = await post({
      ...WESTMINSTER,
      context: {
        narrativeProvided: true,
        answers: [],
        declaredEvidence: [],
        confirmedAssertions: [
          {
            kind: 'HELD_PERMIT',
            stance: 'ASSERTED',
            confirmed: false,
            confidence: 0.9,
            summary: 'Says a resident permit was held at 12 Acacia Avenue.',
          },
        ],
      },
    });

    expect(status).toBe(200);
    const raw = JSON.stringify(json);
    expect(raw).not.toContain('Acacia Avenue');
    expect(raw).not.toContain('Says a resident permit');
  });

  it('rejects an assertion kind outside the vocabulary', async () => {
    const { status } = await post({
      ...WESTMINSTER,
      context: {
        narrativeProvided: true,
        answers: [],
        declaredEvidence: [],
        confirmedAssertions: [{ kind: 'HAS_A_DEFENCE', stance: 'ASSERTED' }],
      },
    });
    expect(status).toBe(400);
  });

  it('accepts a confirmed assertion and reflects it', async () => {
    const { status, json } = await post({
      ...WESTMINSTER,
      context: {
        narrativeProvided: true,
        answers: [],
        declaredEvidence: [],
        confirmedAssertions: [{ kind: 'HELD_PERMIT', stance: 'ASSERTED' }],
      },
    });

    expect(status).toBe(200);
    expect(
      json.assessment.assessment.findings.some(
        (f: { id: string }) => f.id === 'context-user-facts',
      ),
    ).toBe(true);
  });

  it('still works with no assertions at all', async () => {
    const { status, json } = await post(WESTMINSTER);
    expect(status).toBe(200);
    expect(json.assessment.assessment.basis).toBe('INSUFFICIENT_INFORMATION');
  });
});
