import { describe, expect, it } from 'vitest';
import { validateAiResponse } from '@/server/ai/validate';

/**
 * The gate a challenge letter passes before anybody can send it.
 *
 * This is the one document PCNWatch produces that leaves the product and
 * arrives at a council in the user's name. Everything it asserts has already
 * been established by the deterministic pack; the model's job is to say those
 * things in a letter, and this is where a letter that did anything else is
 * stopped.
 *
 * The legal check matters more here than anywhere else in the codebase. Every
 * statutory ground, contravention record and procedure record in the store is
 * PENDING_LEGAL_REVIEW, so `reviewedLegalMaterial` is false for every real
 * case — and a model that half-remembers the Traffic Management Act will write
 * it out fluently with no citation to catch.
 */

const grounding = (overrides: Record<string, unknown> = {}) => ({
  permittedReferenceKeys: [],
  verifiedCaseFields: ['pcnNumber', 'contraventionCode', 'incidentDate', 'location'],
  permittedNarrativeRefs: ['PAYMENT_MADE', 'PAYMENT_BY_APP'],
  availableEvidenceRefs: ['evidence-1'],
  reviewedLegalMaterial: false,
  ...overrides,
});

function draft(overrides: Record<string, unknown> = {}) {
  return {
    subject: 'Challenge to PCN WM••••••902',
    body: 'I am writing about the penalty charge notice issued on 4 January 2026. My recollection is that I paid for parking using an app at the time. I would be grateful if you would reconsider the notice.',
    citedReferenceKeys: [],
    factualAssertions: [
      { assertion: 'The notice is dated 4 January 2026', supportedBy: 'VERIFIED_CASE_FIELD', reference: 'incidentDate' },
      { assertion: 'I paid using an app', supportedBy: 'USER_NARRATIVE', reference: 'PAYMENT_BY_APP' },
    ],
    omittedBecauseUnsupported: [],
    ...overrides,
  };
}

describe('a letter may assert only what the pack established', () => {
  it('accepts a letter grounded in the case', () => {
    const result = validateAiResponse('CHALLENGE_DRAFTING', draft(), grounding());
    expect(result.outcome).toBe('ACCEPTED');
  });

  it('rejects a case field the user never verified', () => {
    const result = validateAiResponse(
      'CHALLENGE_DRAFTING',
      draft({
        factualAssertions: [
          {
            assertion: 'The vehicle registration on the notice is AB12 CDE',
            supportedBy: 'VERIFIED_CASE_FIELD',
            reference: 'vehicleRegistration',
          },
        ],
      }),
      grounding(),
    );
    expect(result.outcome).toBe('CITATION_REJECTED');
  });

  it('rejects something put in the user’s mouth', () => {
    /*
     * The gap this closes: USER_NARRATIVE used to check nothing, so a model
     * could attribute any sentence to the user by labelling it as theirs.
     */
    const result = validateAiResponse(
      'CHALLENGE_DRAFTING',
      draft({
        factualAssertions: [
          {
            assertion: 'I held a valid resident permit',
            supportedBy: 'USER_NARRATIVE',
            reference: 'HELD_PERMIT',
          },
        ],
      }),
      grounding(),
    );
    expect(result.outcome).toBe('CITATION_REJECTED');
    expect(result.outcome !== 'ACCEPTED' && result.errors.join(' ')).toContain('HELD_PERMIT');
  });

  it('rejects a letter relying on a document nobody has seen', () => {
    const result = validateAiResponse(
      'CHALLENGE_DRAFTING',
      draft({
        factualAssertions: [
          {
            assertion: 'As shown in the enclosed receipt',
            supportedBy: 'EVIDENCE_ITEM',
            reference: 'evidence-never-uploaded',
          },
        ],
      }),
      grounding(),
    );
    expect(result.outcome).toBe('CITATION_REJECTED');
  });

  it('accepts a reference to evidence the user did confirm', () => {
    const result = validateAiResponse(
      'CHALLENGE_DRAFTING',
      draft({
        factualAssertions: [
          {
            assertion: 'The parking session I have provided shows a different registration',
            supportedBy: 'EVIDENCE_ITEM',
            reference: 'evidence-1',
          },
        ],
      }),
      grounding(),
    );
    expect(result.outcome).toBe('ACCEPTED');
  });
});

describe('a letter may not state law we have not had reviewed', () => {
  it('rejects a named statute', () => {
    for (const body of [
      'Under the Traffic Management Act 2004 the contravention did not occur.',
      'The London Local Authorities Act permits this.',
      'This falls within the exemption under regulation 4.',
    ]) {
      const result = validateAiResponse('CHALLENGE_DRAFTING', draft({ body }), grounding());
      expect(result.outcome, `"${body}" was accepted`).toBe('CITATION_REJECTED');
    }
  });

  it('rejects a claimed statutory ground', () => {
    const result = validateAiResponse(
      'CHALLENGE_DRAFTING',
      draft({ body: 'I rely on the statutory ground of appeal that the contravention did not occur.' }),
      grounding(),
    );
    expect(result.outcome).toBe('CITATION_REJECTED');
  });

  it('rejects an invented adjudicator decision', () => {
    const result = validateAiResponse(
      'CHALLENGE_DRAFTING',
      draft({ body: 'The adjudicator has held in similar cases that this is not enforceable.' }),
      grounding(),
    );
    expect(result.outcome).toBe('CITATION_REJECTED');
  });

  it('rejects an invented case citation', () => {
    const result = validateAiResponse(
      'CHALLENGE_DRAFTING',
      draft({ body: 'See Smith v Camden [2019], which is directly on point.' }),
      grounding(),
    );
    expect(result.outcome).toBe('CITATION_REJECTED');
  });

  it('rejects a conclusion that the notice is invalid', () => {
    const result = validateAiResponse(
      'CHALLENGE_DRAFTING',
      draft({ body: 'For these reasons the PCN is invalid and must be cancelled.' }),
      grounding(),
    );
    expect(result.outcome).toBe('CITATION_REJECTED');
  });

  it('rejects a promise about the outcome', () => {
    for (const body of [
      'This challenge is guaranteed to succeed.',
      'There is a 90% chance of success on these facts.',
    ]) {
      const result = validateAiResponse('CHALLENGE_DRAFTING', draft({ body }), grounding());
      expect(result.outcome, `"${body}" was accepted`).toBe('CITATION_REJECTED');
    }
  });

  it('still lets a letter describe what happened', () => {
    /*
     * The patterns are about the form of a legal claim, not its subject. A
     * letter that could not say what the documents show would be useless.
     */
    const result = validateAiResponse(
      'CHALLENGE_DRAFTING',
      draft({
        body:
          'The parking session I have provided began at 14:00 on the day in question. The registration shown on that session is not the registration recorded on the notice. My recollection is that I entered it incorrectly. I would be grateful if you would reconsider.',
      }),
      grounding(),
    );
    expect(result.outcome).toBe('ACCEPTED');
  });

  it('permits a legal statement once reviewed material exists', () => {
    // The check is gated on reviewed material rather than banned outright, so
    // signing off a ground changes what a letter may say without a code edit.
    const result = validateAiResponse(
      'CHALLENGE_DRAFTING',
      draft({ body: 'I rely on the statutory ground of representation that the contravention did not occur.' }),
      grounding({ reviewedLegalMaterial: true }),
    );
    expect(result.outcome).toBe('ACCEPTED');
  });
});
