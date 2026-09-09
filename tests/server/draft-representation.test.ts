import { describe, expect, it } from 'vitest';
import { buildCaseView, type CaseRecord } from '@/server/cases/case-view';
import { buildDefencePack } from '@/server/defence/build';
import { validateAiResponse, __forbiddenRepresentationPhrases } from '@/server/ai/validate';
import { CHALLENGE_DRAFT_SYSTEM } from '@/server/ai/prompts';

/**
 * Who the letter says it is from.
 *
 * A real generated Defence Pack contained "I have also told my adviser…".
 * PCNWatch is not the writer's adviser, and a letter saying so misrepresents
 * the relationship to an authority, in a document sent in the writer's name.
 *
 * The guard has to be narrow or it is worse than nothing: a challenge letter
 * may perfectly well say "I sought advice" or "I was advised by the council",
 * and rejecting those would throw away valid letters for no safety gain. So
 * these tests spend as much effort on what must still be accepted as on what
 * must now be refused.
 */

const TODAY = '2026-01-10';

function westminster(): CaseRecord {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    pcnNumber: 'WM77341902', authorityName: 'City of Westminster', authoritySlug: 'westminster',
    noticeCategory: 'LOCAL_AUTHORITY_PCN', contraventionCode: '12', contraventionSuffix: null,
    incidentDate: '2026-01-04', issueDate: '2026-01-04', noticeToOwnerServedDate: null,
    noticeOfRejectionServedDate: null, locationText: 'Gloucester Place',
    discountDeadlinePrinted: '2026-01-18', representationDeadlinePrinted: null,
    parkingLocationSlug: null, fullAmountPence: 13000, discountedAmountPence: 6500,
    proceduralStage: 'NEW', narrativeProvided: true, contextAnswers: [],
    confirmedAssertions: [
      { kind: 'PAYMENT_MADE', stance: 'ASSERTED' },
      { kind: 'PAYMENT_BY_APP', stance: 'ASSERTED' },
      { kind: 'WRONG_VRM_POSSIBLE', stance: 'ASSERTED' },
    ],
    declaredEvidence: [{ type: 'PARKING_APP_RECEIPT', held: 'HAVE' }],
    resolvedFacts: [], assertedGroundKeys: [],
    verifiedFields: {
      pcnNumber: true, contraventionCode: true, incidentDate: true, location: true,
      fullAmountPence: true, issueDate: true, authorityName: true, vehicleRegistration: true,
    },
    evidenceItems: [], noticeSource: 'SCANNED', vehicleRegistration: 'AB12 CDE',
    incidentTime: '14:30', closedAt: null,
  } as CaseRecord;
}

const record = westminster();
const built = buildDefencePack(record, buildCaseView(record, TODAY));

function grounding() {
  return {
    permittedReferenceKeys: built.permittedReferences.referenceKeys,
    verifiedCaseFields: built.permittedReferences.verifiedCaseFields,
    permittedNarrativeRefs: built.permittedReferences.confirmedAssertions,
    availableEvidenceRefs: built.permittedReferences.evidenceRefs,
    reviewedLegalMaterial: built.legalPosition.canStateGrounds,
  };
}

/** The letter the Westminster case should produce, with one sentence swapped. */
function letter(body: string) {
  return {
    subject: 'Challenge to penalty charge notice — Gloucester Place, 4 January 2026',
    body,
    citedReferenceKeys: [],
    factualAssertions: [
      { assertion: 'The notice is dated 4 January 2026', supportedBy: 'VERIFIED_CASE_FIELD', reference: 'incidentDate' },
      { assertion: 'I paid using a parking app', supportedBy: 'USER_NARRATIVE', reference: 'PAYMENT_BY_APP' },
    ],
    omittedBecauseUnsupported: [],
  };
}

const ACCEPTABLE_BODY =
  'I am writing about the penalty charge notice issued on 4 January 2026 at Gloucester Place ' +
  'under contravention code 12. My recollection is that I paid for the parking session at the ' +
  'time using a mobile parking app. I would be grateful if you would reconsider this notice ' +
  'in light of the above and cancel it.';

function verdict(body: string) {
  return validateAiResponse('CHALLENGE_DRAFTING', letter(body), grounding());
}

/** An accepted result carries no `errors`, so this is the assertion message. */
function why(result: { outcome: string }): string {
  return (result as { errors?: readonly string[] }).errors?.join(' | ') ?? '';
}

describe('the letter the product actually produced', () => {
  it('rejects the observed "my adviser" sentence', () => {
    const result = verdict(
      `${ACCEPTABLE_BODY} I have also told my adviser about the circumstances of that day.`,
    );
    expect(result.outcome).not.toBe('ACCEPTED');
    expect(why(result)).toMatch(/adviser or representative/);
  });

  it('accepts the same letter without that sentence', () => {
    const result = verdict(ACCEPTABLE_BODY);
    expect(result.outcome, why(result)).toBe('ACCEPTED');
  });
});

describe('nobody but the writer appears in the letter', () => {
  const refused = [
    'I have also told my adviser about this.',
    'I have also told my advisor about this.',
    'My legal representative has reviewed the notice.',
    'My solicitor will confirm the position.',
    'My lawyer has seen the photographs.',
    'My legal team has looked at this.',
    'My appointed representative will write separately.',
    'Our adviser has considered the notice.',
    'This challenge was prepared with PCNWatch.',
    'I used PCN Watch to review the notice.',
    'My AI tool says the notice is wrong.',
    'An AI assistant helped me write this.',
    'This was drafted by a language model.',
  ];

  for (const sentence of refused) {
    it(`refuses: ${sentence}`, () => {
      const result = verdict(`${ACCEPTABLE_BODY} ${sentence}`);
      expect(result.outcome).not.toBe('ACCEPTED');
    });
  }
});

describe('ordinary English about advice still passes', () => {
  const allowed = [
    'I sought advice before writing to you.',
    'I was advised by the council that I could challenge this notice.',
    'I have been advised that the discount period may still apply.',
    'I would welcome your advice on what further information would help.',
    'I took advice from a friend who has had a similar notice.',
    'The advice on your website says representations may be made in writing.',
    'I am advised the parking session was recorded against another registration.',
    'I would be grateful for advice on how to provide the app record.',
  ];

  for (const sentence of allowed) {
    it(`accepts: ${sentence}`, () => {
      const result = verdict(`${ACCEPTABLE_BODY} ${sentence}`);
      expect(result.outcome, why(result)).toBe('ACCEPTED');
    });
  }

  it('does not trip on the word PCN by itself', () => {
    const result = verdict(
      `${ACCEPTABLE_BODY} The PCN number is WM77341902 and the PCN was issued on 4 January 2026.`,
    );
    expect(result.outcome, why(result)).toBe('ACCEPTED');
  });
});

describe('the instruction and the guard say the same thing', () => {
  it('tells the model, rather than only catching it afterwards', () => {
    // A validator alone turns every such letter into a failed generation. The
    // prompt is what makes the guard rarely fire.
    // The prompt is hard-wrapped for readability, so compare on one line.
    const instruction = CHALLENGE_DRAFT_SYSTEM.replace(/\s+/g, ' ');
    expect(instruction).toMatch(/never write "my adviser"/i);
    expect(instruction).toMatch(/never name PCNWatch/i);
    // And it still says the acceptable half out loud, so the model does not
    // over-correct into avoiding the word "advice" altogether.
    expect(instruction).toMatch(/I sought advice/);
    expect(instruction).toMatch(/I was advised by the council/);
  });

  it('applies to the letter and not to evidence transcription', () => {
    // A document somebody photographs may legitimately contain "solicitor".
    const source = __forbiddenRepresentationPhrases;
    expect(source.length).toBeGreaterThan(0);
    const analysis = validateAiResponse(
      'EVIDENCE_ANALYSIS',
      {
        documentType: 'CORRESPONDENCE',
        legibility: 'CLEAR',
        observations: [
          { field: 'letterText', status: 'READ', value: 'Letter from my solicitor dated 2 January', confidence: 0.95 },
        ],
        supportsAssertions: [],
        contradictsAssertions: [],
        unreadableReason: null,
      },
      grounding(),
    );
    expect(why(analysis)).not.toMatch(/adviser or representative/);
  });
});
