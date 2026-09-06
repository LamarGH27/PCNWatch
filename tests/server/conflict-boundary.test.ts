import { describe, expect, it } from 'vitest';
import { assessVerifiedNotice, type VerifiedFacts } from '@/server/cases/assess-verified';
import { EMPTY_USER_CONTEXT, type UserContext } from '@/core/context/types';
import { POST } from '@/app/api/cases/assess/route';

/**
 * What happens at the boundary when the user's own facts disagree.
 *
 * The endpoint refuses rather than assessing around the problem. The engine
 * would already exclude a disputed fact, so proceeding would be safe in the
 * narrow sense — but it would hand back an assessment quietly built on less
 * than the user believes they told us, with the contradiction still sitting in
 * their answers.
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

/** The scenario from the Preview report, verbatim. */
const RINGGO: UserContext = {
  ...EMPTY_USER_CONTEXT,
  narrativeProvided: true,
  answers: [{ questionId: 'CONTRAVENTION-12#3', answer: 'NO' }],
  confirmedAssertions: [
    { kind: 'PAYMENT_MADE', stance: 'ASSERTED' },
    { kind: 'PAYMENT_BY_APP', stance: 'ASSERTED' },
    { kind: 'WRONG_VRM_POSSIBLE', stance: 'ASSERTED' },
  ],
};

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

describe('the endpoint will not assess around a contradiction', () => {
  it('refuses, and says which fact is in dispute', async () => {
    const { status, json } = await post({ ...WESTMINSTER, context: RINGGO });

    expect(status).toBe(409);
    expect(json.ok).toBe(false);
    expect(json.reason).toBe('UNRESOLVED_CONFLICT');
    expect(json.conflicts).toHaveLength(1);
    expect(json.conflicts[0].topic).toBe('PAYMENT_MADE');
    // Enough for the user to see both sides of their own disagreement.
    expect(json.conflicts[0].questionPrompt).toMatch(/pay-and-display ticket or pay by app/i);
    expect(json.conflicts[0].questionAnswer).toBe('NO');
    expect(json.conflicts[0].fromAccount).toBe('ASSERTED');
    // No assessment came back at all.
    expect(json.assessment).toBeUndefined();
  });

  it('proceeds once the user has chosen', async () => {
    const { status, json } = await post({
      ...WESTMINSTER,
      context: { ...RINGGO, resolvedFacts: [{ topic: 'PAYMENT_MADE', stance: 'ASSERTED' }] },
    });

    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    const finding = json.assessment.assessment.findings.find(
      (f: { id: string }) => f.id === 'context-user-facts',
    );
    expect(finding).toBeDefined();
    expect(finding.whyItMayMatter.toLowerCase()).toContain('you paid to park');
  });

  it('shows one version of the fact, never both', async () => {
    const { json } = await post({
      ...WESTMINSTER,
      context: { ...RINGGO, resolvedFacts: [{ topic: 'PAYMENT_MADE', stance: 'ASSERTED' }] },
    });

    const raw = JSON.stringify(json).toLowerCase();
    // The exact pair that appeared together on the Preview screen. The question
    // is now reconciled onto a topic, so it is not quoted back beside the fact
    // it contradicts.
    expect(raw).toContain('you paid to park');
    expect(raw, 'the questionnaire answer is still printed alongside').not.toContain(
      'did you buy a pay-and-display ticket or pay by app instead? — no.',
    );
  });

  it('does not refuse when the two sources agree', async () => {
    const { status } = await post({
      ...WESTMINSTER,
      context: {
        ...EMPTY_USER_CONTEXT,
        narrativeProvided: true,
        answers: [{ questionId: 'CONTRAVENTION-12#3', answer: 'YES' }],
        confirmedAssertions: [{ kind: 'PAYMENT_MADE', stance: 'ASSERTED' }],
      },
    });
    expect(status).toBe(200);
  });

  it('does not refuse when a question was simply left alone', async () => {
    // The regression that started this: an untouched question must never read
    // as a denial and manufacture a conflict.
    const { status } = await post({
      ...WESTMINSTER,
      context: {
        ...EMPTY_USER_CONTEXT,
        narrativeProvided: true,
        answers: [{ questionId: 'CONTRAVENTION-12#3', answer: 'UNANSWERED' }],
        confirmedAssertions: [{ kind: 'PAYMENT_MADE', stance: 'ASSERTED' }],
      },
    });
    expect(status).toBe(200);
  });
});

describe('the engine excludes a disputed fact even if it is called directly', () => {
  it('reports the dispute and uses neither version', () => {
    // Defence in depth: the endpoint refuses, but the composition function is
    // exported and something else could call it.
    const result = assessVerifiedNotice(WESTMINSTER, RINGGO);

    const finding = result.assessment.findings.find((f) => f.id === 'context-user-facts');
    // The undisputed facts still appear.
    expect(finding!.whyItMayMatter.toLowerCase()).toContain('you paid using an app');
    // The disputed one does not, in either direction.
    expect(finding!.whyItMayMatter.toLowerCase()).not.toContain('you paid to park');

    expect(result.assessment.missingInformation.join(' ')).toMatch(
      /two different answers about you paid to park/i,
    );
    expect(result.assessment.missingInformation.join(' ')).toMatch(/left it out of this assessment/i);
  });

  it('produces exactly one findings block about what the user said', () => {
    // Two blocks is how the contradiction came to be displayed as two
    // confident statements. There is now one, whatever the sources.
    const result = assessVerifiedNotice(WESTMINSTER, {
      ...EMPTY_USER_CONTEXT,
      narrativeProvided: true,
      answers: [
        { questionId: 'CONTRAVENTION-12#0', answer: 'YES' },
        { questionId: 'CONTRAVENTION-12#2', answer: 'NO' },
      ],
      confirmedAssertions: [{ kind: 'PAYMENT_BY_APP', stance: 'ASSERTED' }],
    });

    const contextFindings = result.assessment.findings.filter((f) => f.id.startsWith('context-'));
    const accountFindings = contextFindings.filter((f) => f.category === 'FACTUAL_DISPUTE');
    expect(accountFindings).toHaveLength(1);
    expect(accountFindings[0]!.id).toBe('context-user-facts');
  });

  it('does not duplicate a fact both sources agree on', () => {
    const result = assessVerifiedNotice(WESTMINSTER, {
      ...EMPTY_USER_CONTEXT,
      narrativeProvided: true,
      answers: [{ questionId: 'CONTRAVENTION-12#0', answer: 'YES' }],
      confirmedAssertions: [{ kind: 'HELD_PERMIT', stance: 'ASSERTED' }],
    });

    const finding = result.assessment.findings.find((f) => f.id === 'context-user-facts');
    const text = finding!.whyItMayMatter.toLowerCase();
    const occurrences = text.split('you held a permit').length - 1;
    expect(occurrences, 'the same fact was listed twice').toBe(1);
  });
});

describe('evidence follows the confirmed facts through to the assessment', () => {
  it('leads with the app session for the RingGo case, and keeps the permit last', () => {
    const result = assessVerifiedNotice(WESTMINSTER, {
      ...RINGGO,
      resolvedFacts: [{ topic: 'PAYMENT_MADE', stance: 'ASSERTED' }],
    });

    const order = result.evidenceGuidance.map((item) => item.type);
    expect(order).toContain('PARKING_APP_RECEIPT');
    expect(order).toContain('PERMIT');
    expect(
      order.indexOf('PARKING_APP_RECEIPT'),
      'the permit is still asked for before the app session',
    ).toBeLessThan(order.indexOf('PERMIT'));

    const permit = result.evidenceGuidance.find((item) => item.type === 'PERMIT');
    expect(permit!.priority).toBe('LESS_LIKELY');
    expect(permit!.reason).toMatch(/in case it still matters/i);

    const app = result.evidenceGuidance.find((item) => item.type === 'PARKING_APP_RECEIPT');
    expect(app!.priority).toBe('PRIORITY');
  });

  it('removes nothing', () => {
    const withContext = assessVerifiedNotice(WESTMINSTER, {
      ...RINGGO,
      resolvedFacts: [{ topic: 'PAYMENT_MADE', stance: 'ASSERTED' }],
    });
    const without = assessVerifiedNotice(WESTMINSTER, EMPTY_USER_CONTEXT);

    // Ordering, not deletion. Everything the contravention asks for is still
    // asked for; a user who chose "paid by app" from a list may still have had
    // a permit, and a product that stopped asking would be deciding for them.
    for (const item of without.evidenceGuidance) {
      expect(
        withContext.evidenceGuidance.map((e) => e.type),
        `${item.type} disappeared once the user told us about their case`,
      ).toContain(item.type);
    }
  });

  it('does not reorder anything when the user has told us nothing', () => {
    const result = assessVerifiedNotice(WESTMINSTER, EMPTY_USER_CONTEXT);
    expect(result.evidenceGuidance.every((item) => item.priority === 'STANDARD')).toBe(true);
    expect(result.evidenceGuidance.every((item) => item.reason === null)).toBe(true);
  });

  it('still does not treat a declared document as a held one', () => {
    // Prioritising the app session must not be mistaken for having seen it.
    const result = assessVerifiedNotice(WESTMINSTER, {
      ...RINGGO,
      resolvedFacts: [{ topic: 'PAYMENT_MADE', stance: 'ASSERTED' }],
      declaredEvidence: [
        { type: 'PARKING_APP_RECEIPT', held: 'HAVE' },
        { type: 'PAYMENT_RECEIPT', held: 'HAVE' },
      ],
    });

    expect(result.assessment.basis).not.toBe('STRONG_EVIDENCE_BASIS');
    expect(result.assessment.basis).not.toBe('MODERATE_EVIDENCE_BASIS');
    expect(result.assessment.basisExplanation).toMatch(/we have not seen/i);
    expect(result.assessment.missingInformation.join(' ')).toMatch(
      /you said you can produce parking app session/i,
    );
  });
});
