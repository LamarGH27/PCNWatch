import type { ReferenceRecord } from '../types';

/**
 * Procedural reference records describing what happens at each stage of a London
 * local-authority PCN, and what options the user has.
 *
 * These records drive the "next action" shown on the case dashboard. They are
 * descriptive, not advisory, and are PENDING_LEGAL_REVIEW.
 */

interface ProcedureContent {
  readonly stage: string;
  readonly whatThisMeans: string;
  readonly optionsAvailable: readonly string[];
  readonly nextStageIfNoAction: string | null;
  readonly relevantDeadlineTypes: readonly string[];
}

function procedure(
  key: string,
  title: string,
  content: ProcedureContent,
  summary: string,
): ReferenceRecord {
  return {
    key,
    version: 1,
    category: 'PROCEDURE',
    title,
    jurisdiction: 'ENGLAND_LONDON',
    authorityId: null,
    noticeType: null,
    proceduralStage: content.stage as ReferenceRecord['proceduralStage'],
    sourceName: 'Traffic Management Act 2004, Part 6 and Schedule 1',
    sourceLocation: 'https://www.legislation.gov.uk/ukpga/2004/18/part/6',
    effectiveFrom: '2008-03-31',
    effectiveTo: null,
    reviewedAt: null,
    reviewStatus: 'PENDING_LEGAL_REVIEW',
    summary,
    content: content as unknown as Record<string, unknown>,
  };
}

export const PROCEDURE_RECORDS: readonly ReferenceRecord[] = [
  procedure(
    'PROCEDURE-NEW',
    'A penalty charge notice has been issued',
    {
      stage: 'NEW',
      whatThisMeans:
        'An enforcement authority has issued a penalty charge notice. A reduced amount is normally payable if you pay within the discount period; you can instead challenge the notice.',
      optionsAvailable: [
        'Pay the discounted amount',
        'Make an informal challenge to the authority',
        'Gather evidence before deciding',
      ],
      nextStageIfNoAction: 'NOTICE_TO_OWNER',
      relevantDeadlineTypes: ['DISCOUNT_EXPIRY', 'FULL_AMOUNT_DUE'],
    },
    'A penalty charge notice has been issued and you can either pay the reduced amount or challenge it.',
  ),
  procedure(
    'PROCEDURE-INFORMAL-CHALLENGE',
    'An informal challenge has been made',
    {
      stage: 'INFORMAL_CHALLENGE',
      whatThisMeans:
        'You have written to the authority before a Notice to Owner was issued. The authority will either cancel the notice or reject the challenge and continue enforcement.',
      optionsAvailable: ['Wait for the authority to respond', 'Add further evidence'],
      nextStageIfNoAction: 'NOTICE_TO_OWNER',
      relevantDeadlineTypes: ['DISCOUNT_EXPIRY'],
    },
    'You have challenged the notice informally and are waiting for the authority to respond.',
  ),
  procedure(
    'PROCEDURE-NTO',
    'A Notice to Owner has been served',
    {
      stage: 'NOTICE_TO_OWNER',
      whatThisMeans:
        'The authority has served a Notice to Owner on the registered keeper. This opens the formal representations stage, which relies on specific statutory grounds.',
      optionsAvailable: [
        'Pay the amount shown',
        'Make formal representations on one or more statutory grounds',
      ],
      nextStageIfNoAction: 'CHARGE_CERTIFICATE',
      relevantDeadlineTypes: ['FORMAL_REPRESENTATION_DEADLINE', 'CHARGE_CERTIFICATE_RISK'],
    },
    'A Notice to Owner has been served, opening the formal representations stage.',
  ),
  procedure(
    'PROCEDURE-FORMAL-REPS',
    'Formal representations have been made',
    {
      stage: 'FORMAL_REPRESENTATION',
      whatThisMeans:
        'You have made formal representations to the authority. The authority must consider them and issue either a Notice of Acceptance or a Notice of Rejection.',
      optionsAvailable: ['Wait for the authority’s decision'],
      nextStageIfNoAction: null,
      relevantDeadlineTypes: [],
    },
    'Formal representations have been submitted and the authority must now respond.',
  ),
  procedure(
    'PROCEDURE-REJECTION',
    'Representations have been rejected',
    {
      stage: 'NOTICE_OF_REJECTION',
      whatThisMeans:
        'The authority has rejected your representations. The notice should explain your right to appeal to an independent adjudicator and the period in which to do so.',
      optionsAvailable: ['Pay the amount shown', 'Appeal to the independent adjudicator'],
      nextStageIfNoAction: 'CHARGE_CERTIFICATE',
      relevantDeadlineTypes: ['TRIBUNAL_APPEAL_DEADLINE'],
    },
    'Your representations were rejected. You can pay, or appeal to the independent adjudicator within the stated period.',
  ),
  procedure(
    'PROCEDURE-ACCEPTANCE',
    'Representations have been accepted',
    {
      stage: 'NOTICE_OF_ACCEPTANCE',
      whatThisMeans: 'The authority has accepted your representations and cancelled the penalty charge.',
      optionsAvailable: ['Keep the cancellation notice for your records'],
      nextStageIfNoAction: null,
      relevantDeadlineTypes: [],
    },
    'The authority accepted your representations and the penalty charge has been cancelled.',
  ),
  procedure(
    'PROCEDURE-TRIBUNAL',
    'Appeal to the independent adjudicator',
    {
      stage: 'TRIBUNAL_APPEAL',
      whatThisMeans:
        'An independent adjudicator considers appeals against rejected representations. The adjudicator is independent of the enforcement authority.',
      optionsAvailable: ['Submit your appeal and evidence to the tribunal directly'],
      nextStageIfNoAction: null,
      relevantDeadlineTypes: ['TRIBUNAL_APPEAL_DEADLINE'],
    },
    'An independent adjudicator will consider your appeal. FineRadar does not submit appeals for you.',
  ),
];

export const TRIBUNAL_RECORDS: readonly ReferenceRecord[] = [
  {
    key: 'TRIBUNAL-LONDON',
    version: 1,
    category: 'TRIBUNAL_INFORMATION',
    title: 'London Tribunals — Environment and Traffic Adjudicators',
    jurisdiction: 'ENGLAND_LONDON',
    authorityId: null,
    noticeType: null,
    proceduralStage: 'TRIBUNAL_ELIGIBLE',
    sourceName: 'London Tribunals',
    sourceLocation: 'https://www.londontribunals.gov.uk/',
    effectiveFrom: '2015-01-01',
    effectiveTo: null,
    reviewedAt: null,
    reviewStatus: 'PENDING_LEGAL_REVIEW',
    summary:
      'Appeals against penalty charges issued by London councils are heard by the Environment and Traffic Adjudicators at London Tribunals. There is no charge to appeal.',
    content: {
      appealRoute: 'Environment and Traffic Adjudicators',
      submissionMethod: 'Directly by the appellant, online or by post',
      fineRadarSubmits: false,
      note: 'FineRadar prepares documents. You submit your own appeal.',
    },
  },
];

/**
 * Private parking charges are explicitly out of scope for this version.
 * This record exists so the product has an approved, citable explanation to show
 * rather than pushing a private notice through council rules.
 */
export const PRIVATE_PARKING_RECORDS: readonly ReferenceRecord[] = [
  {
    key: 'GUIDANCE-PRIVATE-PARKING-OUT-OF-SCOPE',
    version: 1,
    category: 'GUIDANCE',
    title: 'Private parking charges are handled differently',
    jurisdiction: 'UK',
    authorityId: null,
    noticeType: 'PRIVATE_PARKING_CHARGE',
    proceduralStage: null,
    sourceName: 'FineRadar product scope',
    sourceLocation: '/legal/scope',
    effectiveFrom: '2026-01-01',
    effectiveTo: null,
    reviewedAt: '2026-01-01',
    reviewStatus: 'REVIEWED',
    summary:
      'This version of FineRadar currently focuses on local-authority PCNs. Private parking charges follow a different process.',
    content: {
      userMessage:
        'This version of FineRadar currently focuses on local-authority PCNs. Private parking charges follow a different process.',
      whyDifferent:
        'A private parking charge is a claim by a landowner or operator under contract law, not a penalty issued under the Traffic Management Act. The appeal routes, deadlines and statutory grounds are different.',
      whatWeDo: 'FineRadar will identify the notice type and stop, rather than applying council rules to it.',
    },
  },
];
