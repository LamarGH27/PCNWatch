import type { ReferenceRecord } from '../types';

/**
 * Statutory grounds for representations against a Notice to Owner.
 *
 * These are the grounds a user may rely on at the FORMAL_REPRESENTATION stage.
 * Every record cites the governing schedule and is PENDING_LEGAL_REVIEW until a
 * qualified reviewer confirms the wording against the current legislation.
 *
 * The assessment engine may only surface a ground that appears here, and the
 * drafting layer may only argue a ground the assessment engine surfaced.
 */

interface GroundContent {
  readonly groundCode: string;
  readonly statutoryWordingSummary: string;
  readonly plainEnglish: string;
  /** Facts that must be established for the ground to be arguable. */
  readonly requiredFacts: readonly string[];
  readonly relevantEvidence: readonly string[];
  /** Stages at which this ground is normally available. */
  readonly availableAtStages: readonly string[];
}

function ground(content: GroundContent): ReferenceRecord {
  return {
    key: `GROUND-${content.groundCode}`,
    version: 1,
    category: 'STATUTORY_GROUND',
    title: content.statutoryWordingSummary,
    jurisdiction: 'ENGLAND_LONDON',
    authorityId: null,
    noticeType: 'NOTICE_TO_OWNER',
    proceduralStage: 'FORMAL_REPRESENTATION',
    sourceName: 'Traffic Management Act 2004, Schedule 1 — representations against a notice to owner',
    sourceLocation: 'https://www.legislation.gov.uk/ukpga/2004/18/schedule/1',
    effectiveFrom: '2008-03-31',
    effectiveTo: null,
    reviewedAt: null,
    reviewStatus: 'PENDING_LEGAL_REVIEW',
    summary: content.plainEnglish,
    content: content as unknown as Record<string, unknown>,
  };
}

export const STATUTORY_GROUND_RECORDS: readonly ReferenceRecord[] = [
  ground({
    groundCode: 'CONTRAVENTION_DID_NOT_OCCUR',
    statutoryWordingSummary: 'The alleged contravention did not occur',
    plainEnglish:
      'You say the events described in the penalty charge notice did not happen — for example the vehicle was not where the notice says, the restriction was not in force, or a valid permit or payment was in place.',
    requiredFacts: [
      'What the notice alleges happened, in its own words',
      'What actually happened, with times',
      'Why the two are inconsistent',
    ],
    relevantEvidence: [
      'COUNCIL_PHOTOGRAPHS',
      'PARKING_SIGN',
      'ROAD_MARKINGS',
      'VEHICLE_POSITION',
      'PAYMENT_RECEIPT',
      'PARKING_APP_RECEIPT',
      'PERMIT',
      'BLUE_BADGE',
    ],
    availableAtStages: ['INFORMAL_CHALLENGE', 'FORMAL_REPRESENTATION', 'TRIBUNAL_APPEAL'],
  }),
  ground({
    groundCode: 'NOT_THE_OWNER',
    statutoryWordingSummary: 'The recipient was not the owner of the vehicle at the material time',
    plainEnglish:
      'You say you were not the person liable for the vehicle when the alleged contravention happened — for example you had already sold it.',
    requiredFacts: [
      'The date ownership changed',
      'Who the vehicle passed to or from',
      'Evidence of the transfer',
    ],
    relevantEvidence: ['CORRESPONDENCE', 'OTHER'],
    availableAtStages: ['FORMAL_REPRESENTATION', 'TRIBUNAL_APPEAL'],
  }),
  ground({
    groundCode: 'TAKEN_WITHOUT_CONSENT',
    statutoryWordingSummary: 'The vehicle had been taken without the owner’s consent',
    plainEnglish:
      'You say the vehicle was being used without your permission at the time, for example because it had been stolen.',
    requiredFacts: [
      'When the vehicle was taken',
      'Whether it was reported, and to whom',
      'Any crime reference number',
    ],
    relevantEvidence: ['CORRESPONDENCE', 'OTHER'],
    availableAtStages: ['FORMAL_REPRESENTATION', 'TRIBUNAL_APPEAL'],
  }),
  ground({
    groundCode: 'HIRE_AGREEMENT',
    statutoryWordingSummary:
      'The recipient is a vehicle-hire firm and the vehicle was on hire under a hiring agreement with a signed statement of liability',
    plainEnglish:
      'A hire company says the hirer, not the company, is liable under a signed hiring agreement.',
    requiredFacts: [
      'The hire agreement reference and dates',
      'That the hirer signed a statement of liability',
    ],
    relevantEvidence: ['CORRESPONDENCE', 'OTHER'],
    availableAtStages: ['FORMAL_REPRESENTATION'],
  }),
  ground({
    groundCode: 'PENALTY_EXCEEDED',
    statutoryWordingSummary: 'The penalty charge exceeded the amount applicable in the circumstances',
    plainEnglish:
      'You say the amount demanded is more than the authority is entitled to charge for this contravention.',
    requiredFacts: [
      'The amount demanded on the notice',
      'The band that applies to the contravention code',
    ],
    relevantEvidence: ['PCN_IMAGE', 'CORRESPONDENCE'],
    availableAtStages: ['INFORMAL_CHALLENGE', 'FORMAL_REPRESENTATION', 'TRIBUNAL_APPEAL'],
  }),
  ground({
    groundCode: 'PROCEDURAL_IMPROPRIETY',
    statutoryWordingSummary: 'There has been a procedural impropriety on the part of the enforcement authority',
    plainEnglish:
      'You say the authority failed to follow a procedure it was required to follow — for example a required detail was missing from the notice, or a notice was not served when it should have been.',
    requiredFacts: [
      'Which step the authority was required to take',
      'What the authority actually did',
      'How that affected you',
    ],
    relevantEvidence: ['PCN_IMAGE', 'CORRESPONDENCE'],
    availableAtStages: ['FORMAL_REPRESENTATION', 'TRIBUNAL_APPEAL'],
  }),
  ground({
    groundCode: 'ORDER_INVALID',
    statutoryWordingSummary: 'The traffic order alleged to have been contravened is invalid',
    plainEnglish:
      'You say the underlying traffic order itself is not valid, so the restriction could not be enforced.',
    requiredFacts: [
      'Which traffic order is said to apply',
      'Why it is said to be invalid',
    ],
    relevantEvidence: ['PARKING_SIGN', 'ROAD_MARKINGS', 'OTHER'],
    availableAtStages: ['FORMAL_REPRESENTATION', 'TRIBUNAL_APPEAL'],
  }),
  ground({
    groundCode: 'ALREADY_PAID',
    statutoryWordingSummary: 'The penalty charge has already been paid, in whole or in part',
    plainEnglish: 'You say you have already paid the penalty charge.',
    requiredFacts: ['Date of payment', 'Amount paid', 'Payment reference'],
    relevantEvidence: ['PAYMENT_RECEIPT', 'CORRESPONDENCE'],
    availableAtStages: ['INFORMAL_CHALLENGE', 'FORMAL_REPRESENTATION', 'TRIBUNAL_APPEAL'],
  }),
];

/**
 * Mitigating circumstances are NOT statutory grounds. An authority may exercise
 * discretion, but an adjudicator's powers are narrower. Keeping this separate stops
 * the drafting layer from presenting mitigation as if it were a legal ground.
 */
export const DISCRETIONARY_RECORDS: readonly ReferenceRecord[] = [
  {
    key: 'GUIDANCE-DISCRETION',
    version: 1,
    category: 'GUIDANCE',
    title: 'Mitigating circumstances and authority discretion',
    jurisdiction: 'ENGLAND_LONDON',
    authorityId: null,
    noticeType: null,
    proceduralStage: null,
    sourceName: 'Statutory guidance to local authorities on the civil enforcement of parking contraventions',
    sourceLocation: 'https://www.gov.uk/government/publications/civil-enforcement-of-parking-contraventions',
    effectiveFrom: '2008-03-31',
    effectiveTo: null,
    reviewedAt: null,
    reviewStatus: 'PENDING_LEGAL_REVIEW',
    summary:
      'An enforcement authority may cancel a penalty charge at its discretion even where a contravention did occur. Mitigating circumstances are not a statutory ground and are not guaranteed to succeed.',
    content: {
      isStatutoryGround: false,
      examples: [
        'A medical emergency at or near the location',
        'A vehicle breakdown supported by recovery evidence',
        'A first contravention shortly after a restriction changed',
        'Signage that was present but genuinely confusing',
      ],
      caution:
        'Mitigation asks the authority to exercise discretion. It does not establish that the contravention did not occur.',
    },
  },
];
