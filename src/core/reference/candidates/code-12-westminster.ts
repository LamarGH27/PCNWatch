import { UNREVIEWED, type CandidateProposition } from './types';

/**
 * The first review bundle: London parking PCN, code 12, Westminster, paid by
 * app, registration possibly wrong.
 *
 * This is the scenario PCNWatch has actually tested end to end, which is why it
 * is the first one taken to review. Everything here is a *candidate*: a
 * proposition PCNWatch would like to be able to state, the document and
 * provision it would have to come from, and the question a qualified reviewer
 * has to answer before it may be stated.
 *
 * WHAT IS DELIBERATELY MISSING, AND WHY
 *
 * Every `excerpt` is null and every `retrieval` is NOT_RETRIEVED. The egress
 * proxy in the environment these candidates were prepared in refuses
 * legislation.gov.uk, londoncouncils.gov.uk, westminster.gov.uk and
 * londontribunals.gov.uk, so no source was opened and no source text was read.
 *
 * The alternative — writing what those documents "say" from a model's
 * recollection — is the one thing this whole architecture exists to prevent. An
 * invented excerpt is worse than an absent one, because it looks exactly like
 * evidence that somebody checked. So the bundle names the document and the
 * provision precisely enough for a reviewer to open it, states the proposition
 * plainly enough for them to agree or disagree with it, and stops there.
 *
 * `isApproved` refuses any candidate whose source was never retrieved, so
 * nothing here can reach a user until a person has both opened the source and
 * recorded what it says.
 */

const TMA_2004_SCHEDULE_1 =
  'https://www.legislation.gov.uk/ukpga/2004/18/schedule/1';
const LONDON_COUNCILS_CODES =
  'https://www.londoncouncils.gov.uk/services/parking-services/parking-and-traffic/contravention-codes';
const WESTMINSTER_CHALLENGE =
  'https://www.westminster.gov.uk/parking/parking-tickets-and-fines';

function candidate(
  input: Omit<CandidateProposition, 'version' | 'review' | 'supersedes' | 'supersededBy'>,
): CandidateProposition {
  return {
    ...input,
    version: 1,
    // The only state a prepared candidate may be in. A model may write the
    // question; only a person may answer it.
    review: UNREVIEWED,
    supersedes: null,
    supersededBy: null,
  };
}

/* ------------------------------------------------------------------ */
/* Contravention — what code 12 alleges                                */
/* ------------------------------------------------------------------ */

const CONTRAVENTION: readonly CandidateProposition[] = [
  candidate({
    id: 'CAND-CODE12-DEFINITION',
    kind: 'CONTRAVENTION_DEFINITION',
    proposition:
      'Contravention code 12 alleges that a vehicle was parked in a residents’ or shared-use parking place or zone without a valid virtual permit or clearly displaying a valid physical permit or voucher, or without payment of the parking charge.',
    reviewQuestion:
      'Open the London Councils contravention code list and confirm the current wording of code 12. Does the proposition state what code 12 alleges, in terms an authority would recognise? Correct the wording if the list differs.',
    doesNotEstablish: [
      'That the contravention did or did not occur in any particular case.',
      'That paying by app is or is not a valid means of payment for a given bay.',
      'Any entitlement, defence or ground of representation.',
    ],
    applicability: {
      contraventionCodes: ['12'],
      authoritySlug: null,
      noticeTypes: null,
      proceduralStages: null,
      conditions: ['London civil parking enforcement only.'],
    },
    source: {
      organisation: 'London Councils',
      documentTitle: 'Parking contravention codes used by London enforcement authorities',
      canonicalUrl: LONDON_COUNCILS_CODES,
      jurisdiction: 'ENGLAND_LONDON',
      provision: 'Code 12',
      tier: 'LONDON_COUNCILS_FRAMEWORK',
      documentDate: null,
      retrievedAt: null,
      retrieval: 'NOT_RETRIEVED',
      excerpt: null,
    },
  }),
  candidate({
    id: 'CAND-CODE12-SUFFIXES',
    kind: 'CONTRAVENTION_DEFINITION',
    proposition:
      'Code 12 is issued with suffix letters that distinguish the circumstances alleged, and the suffix identifies the specific restriction rather than changing the contravention.',
    reviewQuestion:
      'Confirm from the London Councils list which suffixes are in current use with code 12, and what each denotes. Record the enumerated list, or reject this candidate if suffixes are not maintained in the form described.',
    doesNotEstablish: [
      'The meaning of any individual suffix. Each would need its own candidate.',
      'That a suffix creates, removes or alters any ground of representation.',
    ],
    applicability: {
      contraventionCodes: ['12'],
      authoritySlug: null,
      noticeTypes: null,
      proceduralStages: null,
      conditions: [
        'PCNWatch currently declines to interpret a suffix at all and says so. This candidate exists to replace that silence with something enumerated, not to license inference.',
      ],
    },
    source: {
      organisation: 'London Councils',
      documentTitle: 'Parking contravention codes used by London enforcement authorities',
      canonicalUrl: LONDON_COUNCILS_CODES,
      jurisdiction: 'ENGLAND_LONDON',
      provision: 'Code 12, suffix table',
      tier: 'LONDON_COUNCILS_FRAMEWORK',
      documentDate: null,
      retrievedAt: null,
      retrieval: 'NOT_RETRIEVED',
      excerpt: null,
    },
  }),
  candidate({
    id: 'CAND-CODE12-ELECTRONIC-PAYMENT',
    kind: 'CONTRAVENTION_DEFINITION',
    proposition:
      'Where a parking place is operated with electronic or virtual permits, an enforcement officer verifies payment or permit status against the vehicle registration mark rather than against a displayed ticket.',
    reviewQuestion:
      'Confirm whether the London Councils framework or Westminster’s published material states how virtual permit and electronic payment status is checked. If neither states it, REJECT this candidate: it is the mechanism the whole incorrect-registration scenario turns on and it must not rest on inference.',
    doesNotEstablish: [
      'That a mismatch between the registration paid for and the registration on the notice means no contravention occurred.',
      'That the authority is obliged to search for a payment against a different registration.',
      'Any statutory ground.',
    ],
    applicability: {
      contraventionCodes: ['12'],
      authoritySlug: null,
      noticeTypes: null,
      proceduralStages: null,
      conditions: ['Applies only to bays operated by electronic or virtual permit.'],
    },
    source: {
      organisation: 'London Councils',
      documentTitle: 'Parking contravention codes used by London enforcement authorities',
      canonicalUrl: LONDON_COUNCILS_CODES,
      jurisdiction: 'ENGLAND_LONDON',
      provision: 'To be identified by the reviewer',
      tier: 'LONDON_COUNCILS_FRAMEWORK',
      documentDate: null,
      retrievedAt: null,
      retrieval: 'NOT_RETRIEVED',
      excerpt: null,
    },
  }),
];

/* ------------------------------------------------------------------ */
/* Statutory grounds — the framework, at the stage that has one        */
/* ------------------------------------------------------------------ */

const STATUTORY: readonly CandidateProposition[] = [
  candidate({
    id: 'CAND-TMA-REPS-STAGE',
    kind: 'PROCEDURE',
    proposition:
      'The statutory grounds of representation apply to representations made against a Notice to Owner, and not to an informal challenge made before one has been served.',
    reviewQuestion:
      'Confirm from Schedule 1 which document representations are made against, and at which point the statutory grounds become available. This governs every other statutory candidate in this bundle: if the stage is wrong, they are all scoped wrongly.',
    doesNotEstablish: [
      'That an informal challenge is pointless or that an authority will not consider one.',
      'The content of any individual ground.',
    ],
    applicability: {
      contraventionCodes: null,
      authoritySlug: null,
      noticeTypes: ['NOTICE_TO_OWNER'],
      proceduralStages: ['FORMAL_REPRESENTATION'],
      conditions: [],
    },
    source: {
      organisation: 'UK Parliament (legislation.gov.uk)',
      documentTitle: 'Traffic Management Act 2004, Schedule 1',
      canonicalUrl: TMA_2004_SCHEDULE_1,
      jurisdiction: 'ENGLAND_LONDON',
      provision: 'Schedule 1 — representations against a notice to owner',
      tier: 'PRIMARY_LEGISLATION',
      documentDate: null,
      retrievedAt: null,
      retrieval: 'NOT_RETRIEVED',
      excerpt: null,
    },
  }),
  candidate({
    id: 'CAND-TMA-GROUND-LIST',
    kind: 'STATUTORY_GROUND',
    proposition:
      'Schedule 1 sets out an exhaustive list of grounds on which representations against a Notice to Owner may be made.',
    reviewQuestion:
      'Enumerate the grounds as currently in force and confirm the list is exhaustive. PCNWatch holds eight ground records written before any review; check each against the provision and record which are correctly stated, which need rewording, and which do not exist.',
    doesNotEstablish: [
      'The wording of any individual ground.',
      'That any ground is available on the facts of any case.',
      'That an authority must accept a representation made on a listed ground.',
    ],
    applicability: {
      contraventionCodes: null,
      authoritySlug: null,
      noticeTypes: ['NOTICE_TO_OWNER'],
      proceduralStages: ['FORMAL_REPRESENTATION'],
      conditions: [],
    },
    source: {
      organisation: 'UK Parliament (legislation.gov.uk)',
      documentTitle: 'Traffic Management Act 2004, Schedule 1',
      canonicalUrl: TMA_2004_SCHEDULE_1,
      jurisdiction: 'ENGLAND_LONDON',
      provision: 'Schedule 1 — grounds for representations',
      tier: 'PRIMARY_LEGISLATION',
      documentDate: null,
      retrievedAt: null,
      retrieval: 'NOT_RETRIEVED',
      excerpt: null,
    },
  }),
  candidate({
    id: 'CAND-TMA-GROUND-NO-CONTRAVENTION',
    kind: 'STATUTORY_GROUND',
    proposition:
      'One of the grounds of representation is that the alleged contravention did not occur.',
    reviewQuestion:
      'Confirm the exact statutory wording of this ground and record it verbatim. This is the only ground the paid-by-app scenario would plausibly engage, so its wording matters more than any other candidate here.',
    doesNotEstablish: [
      'That a payment made against a different registration means the contravention did not occur. That is a question of fact for the authority and, on appeal, the adjudicator.',
      'That raising this ground obliges an authority to cancel.',
      'Any view about how likely the ground is to succeed.',
    ],
    applicability: {
      contraventionCodes: null,
      authoritySlug: null,
      noticeTypes: ['NOTICE_TO_OWNER'],
      proceduralStages: ['FORMAL_REPRESENTATION'],
      conditions: [],
    },
    source: {
      organisation: 'UK Parliament (legislation.gov.uk)',
      documentTitle: 'Traffic Management Act 2004, Schedule 1',
      canonicalUrl: TMA_2004_SCHEDULE_1,
      jurisdiction: 'ENGLAND_LONDON',
      provision: 'Schedule 1 — ground: contravention did not occur',
      tier: 'PRIMARY_LEGISLATION',
      documentDate: null,
      retrievedAt: null,
      retrieval: 'NOT_RETRIEVED',
      excerpt: null,
    },
  }),
  candidate({
    id: 'CAND-TMA-GROUND-PAID-DISTINCTION',
    kind: 'STATUTORY_GROUND',
    proposition:
      'The ground concerning payment of the penalty charge concerns payment of the penalty charge itself, and is not a ground that the parking charge was paid.',
    reviewQuestion:
      'Confirm the wording of the payment-related ground. PCNWatch holds a record keyed GROUND-ALREADY_PAID; check whether it describes payment of the penalty or payment for parking. If it conflates the two, REJECT the existing record — a user who paid by app has not paid the penalty, and telling them otherwise would send a representation on a ground that does not apply.',
    doesNotEstablish: [
      'That paying for parking engages any ground.',
      'That paying for parking is irrelevant. It is a factual matter, which is where PCNWatch already puts it.',
    ],
    applicability: {
      contraventionCodes: null,
      authoritySlug: null,
      noticeTypes: ['NOTICE_TO_OWNER'],
      proceduralStages: ['FORMAL_REPRESENTATION'],
      conditions: [],
    },
    source: {
      organisation: 'UK Parliament (legislation.gov.uk)',
      documentTitle: 'Traffic Management Act 2004, Schedule 1',
      canonicalUrl: TMA_2004_SCHEDULE_1,
      jurisdiction: 'ENGLAND_LONDON',
      provision: 'Schedule 1 — ground relating to payment of the penalty charge',
      tier: 'PRIMARY_LEGISLATION',
      documentDate: null,
      retrievedAt: null,
      retrieval: 'NOT_RETRIEVED',
      excerpt: null,
    },
  }),
];

/* ------------------------------------------------------------------ */
/* Westminster policy — discretion, and only discretion               */
/* ------------------------------------------------------------------ */

const POLICY: readonly CandidateProposition[] = [
  candidate({
    id: 'CAND-WCC-INDIVIDUAL-MERITS',
    kind: 'AUTHORITY_POLICY',
    proposition:
      'Westminster City Council states that it considers each challenge to a penalty charge notice on its individual merits.',
    reviewQuestion:
      'Find and confirm the published Westminster statement to this effect, and record where it appears. If Westminster publishes no such statement, REJECT rather than substituting a general expectation about how authorities behave.',
    doesNotEstablish: [
      'Any obligation to cancel a notice.',
      'Any statutory ground or entitlement.',
      'That any other authority does the same.',
    ],
    applicability: {
      contraventionCodes: null,
      authoritySlug: 'westminster',
      noticeTypes: null,
      proceduralStages: null,
      conditions: ['Westminster only. Not to be generalised to other London authorities.'],
    },
    source: {
      organisation: 'Westminster City Council',
      documentTitle: 'Parking tickets and fines — challenging a PCN',
      canonicalUrl: WESTMINSTER_CHALLENGE,
      jurisdiction: 'ENGLAND_LONDON',
      provision: null,
      tier: 'ISSUING_AUTHORITY_POLICY',
      documentDate: null,
      retrievedAt: null,
      retrieval: 'NOT_RETRIEVED',
      excerpt: null,
    },
  }),
  candidate({
    id: 'CAND-WCC-GENUINE-MISTAKE',
    kind: 'AUTHORITY_POLICY',
    proposition:
      'Westminster City Council publishes the circumstances in which it will consider exercising discretion to cancel a penalty charge notice, which include cases described as a genuine mistake.',
    reviewQuestion:
      'Confirm whether Westminster publishes such a policy and record its actual terms and any stated conditions. This is the proposition closest to the paid-by-app scenario and the easiest to overstate: confirm the words, and confirm they describe discretion rather than entitlement.',
    doesNotEstablish: [
      'That a mistaken registration entry is a genuine mistake within the policy.',
      'That the policy obliges Westminster to cancel anything.',
      'That an adjudicator would take the same view.',
      'Any statutory ground. Discretion and entitlement are different things and this bundle keeps them apart.',
    ],
    applicability: {
      contraventionCodes: null,
      authoritySlug: 'westminster',
      noticeTypes: null,
      proceduralStages: null,
      conditions: ['Westminster only.'],
    },
    source: {
      organisation: 'Westminster City Council',
      documentTitle: 'Parking tickets and fines — challenging a PCN',
      canonicalUrl: WESTMINSTER_CHALLENGE,
      jurisdiction: 'ENGLAND_LONDON',
      provision: null,
      tier: 'ISSUING_AUTHORITY_POLICY',
      documentDate: null,
      retrievedAt: null,
      retrieval: 'NOT_RETRIEVED',
      excerpt: null,
    },
  }),
  candidate({
    id: 'CAND-WCC-EVIDENCE-CONSIDERED',
    kind: 'AUTHORITY_POLICY',
    proposition:
      'Westminster City Council states that evidence submitted with a challenge will be considered, and describes how it should be provided.',
    reviewQuestion:
      'Confirm what Westminster publishes about submitting evidence with a challenge, including any format or deadline it states. PCNWatch tells users an authority will weigh their documents; confirm that is what Westminster actually says.',
    doesNotEstablish: [
      'Any particular weight that will be given to any evidence.',
      'That providing evidence obliges the authority to cancel.',
    ],
    applicability: {
      contraventionCodes: null,
      authoritySlug: 'westminster',
      noticeTypes: null,
      proceduralStages: null,
      conditions: ['Westminster only.'],
    },
    source: {
      organisation: 'Westminster City Council',
      documentTitle: 'Parking tickets and fines — challenging a PCN',
      canonicalUrl: WESTMINSTER_CHALLENGE,
      jurisdiction: 'ENGLAND_LONDON',
      provision: null,
      tier: 'ISSUING_AUTHORITY_POLICY',
      documentDate: null,
      retrievedAt: null,
      retrieval: 'NOT_RETRIEVED',
      excerpt: null,
    },
  }),
];

/* ------------------------------------------------------------------ */
/* Deadlines — the two this scenario needs, and their triggers         */
/* ------------------------------------------------------------------ */

const DEADLINES: readonly CandidateProposition[] = [
  candidate({
    id: 'CAND-DEADLINE-DISCOUNT-14D',
    kind: 'DEADLINE_RULE',
    proposition:
      'A penalty charge notice is payable at the discounted rate if paid within 14 days, and the period runs from a date fixed by statute rather than from the date the notice is received.',
    reviewQuestion:
      'Confirm the period and, more importantly, the exact event it runs from — service, issue, or the date shown on the notice — and how service is deemed to occur for a postal notice. PCNWatch holds rule LDN-DISCOUNT-14D unreviewed; approving this candidate is what would let a calculated discount date be shown at all.',
    doesNotEstablish: [
      'The date on any particular notice.',
      'That a printed date on a notice is correct. PCNWatch shows printed dates because the user confirmed them, which is a different basis.',
      'Any period for making representations.',
    ],
    applicability: {
      contraventionCodes: null,
      authoritySlug: null,
      noticeTypes: ['PCN_ON_STREET', 'PCN_POSTAL'],
      proceduralStages: null,
      conditions: ['London civil parking enforcement.'],
    },
    source: {
      organisation: 'UK Parliament (legislation.gov.uk)',
      documentTitle: 'Traffic Management Act 2004 and the regulations made under it',
      canonicalUrl: TMA_2004_SCHEDULE_1,
      jurisdiction: 'ENGLAND_LONDON',
      provision: 'To be identified: the provision fixing the discount period and its trigger',
      tier: 'PRIMARY_LEGISLATION',
      documentDate: null,
      retrievedAt: null,
      retrieval: 'NOT_RETRIEVED',
      excerpt: null,
    },
  }),
  candidate({
    id: 'CAND-DEADLINE-REPS-28D',
    kind: 'DEADLINE_RULE',
    proposition:
      'Representations against a Notice to Owner must be made within a period fixed by statute, running from service of that notice.',
    reviewQuestion:
      'Confirm the length of the period and the event it runs from, and whether deemed service applies. Do not approve a period taken from a summary: this is the deadline whose miscalculation would cost somebody their right to make representations.',
    doesNotEstablish: [
      'Any discount period.',
      'That an authority will refuse a late representation.',
    ],
    applicability: {
      contraventionCodes: null,
      authoritySlug: null,
      noticeTypes: ['NOTICE_TO_OWNER'],
      proceduralStages: ['FORMAL_REPRESENTATION'],
      conditions: [],
    },
    source: {
      organisation: 'UK Parliament (legislation.gov.uk)',
      documentTitle: 'Traffic Management Act 2004, Schedule 1',
      canonicalUrl: TMA_2004_SCHEDULE_1,
      jurisdiction: 'ENGLAND_LONDON',
      provision: 'Schedule 1 — period for making representations',
      tier: 'PRIMARY_LEGISLATION',
      documentDate: null,
      retrievedAt: null,
      retrieval: 'NOT_RETRIEVED',
      excerpt: null,
    },
  }),
];

export const CODE_12_WESTMINSTER_BUNDLE: readonly CandidateProposition[] = [
  ...CONTRAVENTION,
  ...STATUTORY,
  ...POLICY,
  ...DEADLINES,
];
