import { describe, expect, it, vi, afterEach } from 'vitest';
import { assessVerifiedNotice, type VerifiedFacts } from '@/server/cases/assess-verified';
import { EMPTY_USER_CONTEXT, type UserContext } from '@/core/context/types';
import { selectContextQuestions } from '@/core/context/questions';
import { POST } from '@/app/api/cases/assess/route';

/**
 * What the user's own account does, and — mostly — what it does not do.
 *
 * The failure this file exists to catch is flattery: a user types a confident
 * story, ticks that they hold a permit nobody has seen, and the product tells
 * them their case is well evidenced. Everything below is a boundary on that.
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

const PERMIT_QUESTION = 'CONTRAVENTION-12#0';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the account and answers reach the assessment', () => {
  it('uses the answers the user gave', () => {
    const result = assessVerifiedNotice(
      WESTMINSTER,
      context({ answers: [{ questionId: PERMIT_QUESTION, answer: 'YES' }] }),
    );

    const finding = result.assessment.findings.find((f) => f.id === 'context-user-account');
    expect(finding, 'the account produced no finding').toBeDefined();
    expect(finding!.issue).toMatch(/what you have told us/i);
    // The question's own wording, quoted back from the reference store.
    expect(finding!.whyItMayMatter).toContain('Did you hold a valid permit for that bay at that time?');
    expect(finding!.whyItMayMatter).toMatch(/yes\./);
    // And it says whose account it is, rather than presenting it as our finding.
    expect(finding!.whyItMayMatter).toMatch(/this is your account, not a finding of ours/i);
  });

  it('turns declared evidence into something we still need to see', () => {
    const result = assessVerifiedNotice(
      WESTMINSTER,
      context({ declaredEvidence: [{ type: 'PERMIT', held: 'HAVE' }] }),
    );

    expect(result.assessment.missingInformation.join(' ')).toMatch(
      /you said you can produce parking permit\. we have not seen it/i,
    );
  });

  it('records not knowing as a gap it could close', () => {
    const result = assessVerifiedNotice(
      WESTMINSTER,
      context({ answers: [{ questionId: PERMIT_QUESTION, answer: 'UNSURE' }] }),
    );
    expect(result.assessment.missingInformation.join(' ')).toMatch(/you were not sure/i);
  });

  it('keeps mitigation out of the grounds and says what it is', () => {
    const result = assessVerifiedNotice(
      WESTMINSTER,
      context({ answers: [{ questionId: 'GENERAL#mitigation', answer: 'YES' }] }),
    );

    const finding = result.assessment.findings.find((f) => f.id === 'context-mitigation');
    expect(finding).toBeDefined();
    // DISCRETIONARY, not STATUTORY_GROUND. An authority's discretion and a
    // statutory ground are not the same thing and must not read alike.
    expect(finding!.category).toBe('DISCRETIONARY');
    expect(finding!.groundKey).toBeNull();
    expect(finding!.whyItMayMatter).toMatch(/does not establish that the contravention did not occur/i);
    expect(result.assessment.findingsByCategory.STATUTORY_GROUND).toHaveLength(0);
  });
});

describe('an account alone does not become evidence', () => {
  it('does not reach a strong or moderate basis on a story with nothing behind it', () => {
    const result = assessVerifiedNotice(
      WESTMINSTER,
      context({
        answers: [
          { questionId: PERMIT_QUESTION, answer: 'YES' },
          { questionId: 'CONTRAVENTION-12#1', answer: 'YES' },
          { questionId: 'CONTRAVENTION-12#2', answer: 'YES' },
          { questionId: 'CONTRAVENTION-12#3', answer: 'YES' },
        ],
      }),
    );

    expect(result.assessment.basis).not.toBe('STRONG_EVIDENCE_BASIS');
    expect(result.assessment.basis).not.toBe('MODERATE_EVIDENCE_BASIS');
    expect(result.assessment.basisExplanation).toMatch(/rest on your account alone/i);
  });

  it('does not let declared evidence do the work of held evidence', () => {
    // Every relevant document claimed, none of them seen.
    const everything = assessVerifiedNotice(
      WESTMINSTER,
      context({
        declaredEvidence: (
          ['PERMIT', 'PAYMENT_RECEIPT', 'PARKING_APP_RECEIPT', 'COUNCIL_PHOTOGRAPHS', 'PARKING_SIGN'] as const
        ).map((type) => ({ type, held: 'HAVE' as const })),
      }),
    );

    expect(everything.assessment.basis).toBe('WEAK_EVIDENCE_BASIS');
    expect(everything.assessment.basisExplanation).toMatch(/we have not seen/i);
  });

  it('never states a chance of success', () => {
    const result = assessVerifiedNotice(
      WESTMINSTER,
      context({
        answers: [{ questionId: PERMIT_QUESTION, answer: 'YES' }],
        declaredEvidence: [{ type: 'PERMIT', held: 'HAVE' }],
      }),
    );

    const text = JSON.stringify(result).toLowerCase();
    for (const phrase of [
      'you will win',
      'likely to succeed',
      'good chance',
      'probability',
      '% chance',
      'we recommend you challenge',
      'you should appeal',
    ]) {
      expect(text, `the assessment said "${phrase}"`).not.toContain(phrase);
    }
    expect(result.assessment.basisExplanation).toMatch(/not a prediction of the outcome/i);
  });

  it('asserts no statutory ground however the user answers', () => {
    const set = selectContextQuestions({
      contraventionCode: '12',
      noticeType: 'PCN_POSTAL',
      proceduralStage: 'NEW',
    });
    const result = assessVerifiedNotice(
      WESTMINSTER,
      context({ answers: set.questions.map((q) => ({ questionId: q.id, answer: 'YES' as const })) }),
    );

    // Answering yes to everything is the strongest possible input. It still
    // must not manufacture a ground the user never chose to rely on.
    expect(result.assessment.findingsByCategory.STATUTORY_GROUND).toHaveLength(0);
    expect(result.assessment.findings.every((f) => f.groundKey === null)).toBe(true);
  });
});

describe('skipping is a supported answer', () => {
  it('still produces an assessment, and says what it is missing', () => {
    const result = assessVerifiedNotice(WESTMINSTER, EMPTY_USER_CONTEXT);

    expect(result.supported).toBe(true);
    expect(result.assessment.basis).toBe('INSUFFICIENT_INFORMATION');
    expect(result.assessment.missingInformation.join(' ')).toMatch(
      /you have not yet told us what actually happened/i,
    );
    // The contravention's meaning is still there — skipping costs the tailoring,
    // not the whole page.
    expect(result.contravention.meaning).toBeTruthy();
  });

  it('says more once the user does tell us', () => {
    const skipped = assessVerifiedNotice(WESTMINSTER, EMPTY_USER_CONTEXT);
    const told = assessVerifiedNotice(
      WESTMINSTER,
      context({
        answers: [{ questionId: PERMIT_QUESTION, answer: 'YES' }],
        declaredEvidence: [{ type: 'PERMIT', held: 'HAVE' }],
      }),
    );

    expect(told.assessment.findings.length).toBeGreaterThan(skipped.assessment.findings.length);
    expect(told.assessment.basis).not.toBe(skipped.assessment.basis);
  });
});

describe('answers cannot change the notice', () => {
  it('leaves every verified fact exactly as it was', () => {
    const skipped = assessVerifiedNotice(WESTMINSTER, EMPTY_USER_CONTEXT);
    const answered = assessVerifiedNotice(
      WESTMINSTER,
      context({
        answers: [{ questionId: PERMIT_QUESTION, answer: 'NO' }],
        declaredEvidence: [{ type: 'PERMIT', held: 'DO_NOT_HAVE' }],
      }),
    );

    // The notice's own facts, the dates and the classification are the user's
    // verified reading of the document. Nothing they say afterwards may move them.
    expect(answered.contravention).toEqual(skipped.contravention);
    expect(answered.stage).toBe(skipped.stage);
    expect(answered.authority).toEqual(skipped.authority);
    expect(answered.printedDeadlines).toEqual(skipped.printedDeadlines);
    expect(answered.calculatedDeadlines).toEqual(skipped.calculatedDeadlines);
    expect(answered.refusedDeadlines).toEqual(skipped.refusedDeadlines);
    expect(answered.amountSummary).toEqual(skipped.amountSummary);
    expect(answered.supported).toBe(skipped.supported);
  });

  it('ignores an answer to a question that does not exist', () => {
    const result = assessVerifiedNotice(
      WESTMINSTER,
      context({
        answers: [
          { questionId: 'CONTRAVENTION-12#0', answer: 'YES' },
          { questionId: 'GROUND-ALREADY_PAID#0', answer: 'YES' },
          { questionId: 'made-up-entirely', answer: 'YES' },
        ],
      }),
    );

    const finding = result.assessment.findings.find((f) => f.id === 'context-user-account');
    expect(finding!.whyItMayMatter).toContain('Did you hold a valid permit');
    expect(finding!.whyItMayMatter).not.toContain('made-up-entirely');
    expect(finding!.whyItMayMatter).not.toMatch(/already paid/i);
  });
});

describe('the private parking boundary is unaffected', () => {
  it('refuses council logic however much context is supplied', () => {
    const result = assessVerifiedNotice(
      { ...WESTMINSTER, noticeType: 'PRIVATE_PARKING_CHARGE', authorityName: 'ParkingEye Ltd' },
      context({
        answers: [{ questionId: PERMIT_QUESTION, answer: 'YES' }],
        declaredEvidence: [{ type: 'PERMIT', held: 'HAVE' }],
      }),
    );

    expect(result.supported).toBe(false);
    expect(result.assessment.outOfScope).toBe(true);
    expect(result.assessment.findings).toHaveLength(0);
    expect(result.calculatedDeadlines).toHaveLength(0);
  });
});

describe('the endpoint', () => {
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

  it('accepts a context and reflects it', async () => {
    const { status, json } = await post({
      ...WESTMINSTER,
      context: {
        narrativeProvided: true,
        answers: [{ questionId: PERMIT_QUESTION, answer: 'YES' }],
        declaredEvidence: [{ type: 'PERMIT', held: 'HAVE' }],
      },
    });

    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(
      json.assessment.assessment.findings.some(
        (f: { id: string }) => f.id === 'context-user-account',
      ),
    ).toBe(true);
  });

  it('works without a context at all', async () => {
    const { status, json } = await post(WESTMINSTER);
    expect(status).toBe(200);
    expect(json.assessment.assessment.basis).toBe('INSUFFICIENT_INFORMATION');
  });

  it('rejects an answer outside the fixed set', async () => {
    const { status } = await post({
      ...WESTMINSTER,
      context: {
        narrativeProvided: true,
        answers: [{ questionId: PERMIT_QUESTION, answer: 'PROBABLY' }],
        declaredEvidence: [],
      },
    });
    expect(status).toBe(400);
  });

  it('has no field for the narrative text, so none can be sent', async () => {
    // The account stays in the browser. If a client sends prose anyway it is
    // stripped by the schema rather than reaching a log, a finding or a store.
    const { status, json } = await post({
      ...WESTMINSTER,
      context: {
        narrativeProvided: true,
        narrative: 'My name is Jane Smith of 12 Acacia Avenue and I was at St Thomas Hospital.',
        answers: [],
        declaredEvidence: [],
      },
    });

    expect(status).toBe(200);
    const raw = JSON.stringify(json);
    for (const leak of ['Jane Smith', 'Acacia Avenue', 'St Thomas']) {
      expect(raw, `${leak} came back from the server`).not.toContain(leak);
    }
  });

  it('writes nothing about the user to the logs', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await post({
      ...WESTMINSTER,
      pcnNumber: 'WM77341902',
      vehicleRegistration: 'LT19XYZ',
      context: {
        narrativeProvided: true,
        narrative: 'I am Jane Smith and I was visiting St Thomas Hospital.',
        answers: [{ questionId: PERMIT_QUESTION, answer: 'YES' }],
        declaredEvidence: [{ type: 'PERMIT', held: 'HAVE' }],
      },
    });

    const written = [...error.mock.calls, ...log.mock.calls].flat().join(' ');
    for (const secret of [
      'Jane Smith',
      'St Thomas',
      'WM77341902',
      'LT19XYZ',
      'Gloucester Place',
    ]) {
      expect(written, `"${secret}" was logged`).not.toContain(secret);
    }
  });
});
