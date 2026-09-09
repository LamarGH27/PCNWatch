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

/*
 * The 2022 Regulations are named by title rather than by SI number.
 *
 * Several propositions below now live in the Civil Enforcement of Road Traffic
 * Contraventions (Representations and Appeals) (England) Regulations 2022,
 * made under the 2004 Act. I do not have the SI number to a standard I would
 * put in a URL a reviewer will trust, and guessing one is precisely the failure
 * this file exists to prevent — a wrong legislation.gov.uk link looks exactly
 * like a checked one.
 *
 * So the canonical URL stays on the enabling Act, which I can state correctly,
 * and locating the instrument is the reviewer's first task on each affected
 * candidate. Their review question says so in as many words.
 */
const REGS_2022_TITLE =
  'The Civil Enforcement of Road Traffic Contraventions (Representations and Appeals) (England) Regulations 2022';
const LEGISLATION_UKSI_2022 = 'https://www.legislation.gov.uk/uksi/2022';

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
      'Code 12 describes parking in a residents\u2019 or shared-use parking place or zone without the required valid virtual or physical permit, voucher, pay-and-display ticket, or payment of the parking charge.',
    reviewQuestion:
      'Open the London Councils contravention code list and confirm the current wording of code 12 against this statement. Record the exact wording. Reject if the code has been reworded, split, or withdrawn.',
    doesNotEstablish: [
      'That the contravention occurred. The code records what the authority alleges, and nothing more.',
      'That the vehicle was in fact parked without a valid permit or payment.',
      'Any ground of representation, and any entitlement to cancellation.',
      'What any suffix letter denotes. Each suffix is a separate candidate against a separate table.',
      'That the underlying traffic order was valid, or that the bay was correctly signed.',
    ],
    applicability: {
      contraventionCodes: ['12'],
      authoritySlug: null,
      noticeTypes: null,
      proceduralStages: null,
      conditions: [
        'London local-authority parking PCNs only.',
        'Do not infer from the code alone that the allegation is proven.',
      ],
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
    kind: 'CONTRAVENTION_METADATA',
    proposition:
      'For permit contraventions including code 12, the code-specific suffix "x" denotes an incorrect vehicle registration mark.',
    reviewQuestion:
      'Open the London Councils suffix table and confirm that "x" is a code-specific suffix denoting an incorrect VRM, and that it is in current use with code 12. Record the exact table wording. Reject if the suffix has been withdrawn, renumbered, or means something else for this code.',
    doesNotEstablish: [
      'That the notice is cancelled, or must be cancelled, because the suffix is present.',
      'That an incorrect VRM is a statutory defence or a ground of representation.',
      'That payment was in fact made. The suffix records what the authority alleges, not what happened.',
      'That the authority is obliged to search for a payment made against a different registration.',
    ],
    applicability: {
      contraventionCodes: ['12'],
      authoritySlug: null,
      noticeTypes: null,
      proceduralStages: null,
      conditions: [
        'London local-authority parking PCNs only.',
        'PCNWatch currently declines to interpret a suffix at all and says so. This candidate exists to replace that silence with one enumerated meaning, not to license inference from it.',
      ],
    },
    source: {
      organisation: 'London Councils',
      documentTitle: 'Parking contravention codes used by London enforcement authorities',
      canonicalUrl: LONDON_COUNCILS_CODES,
      jurisdiction: 'ENGLAND_LONDON',
      provision: 'Code 12 — code-specific suffix table, suffix "x"',
      tier: 'LONDON_COUNCILS_FRAMEWORK',
      documentDate: null,
      retrievedAt: null,
      retrieval: 'NOT_RETRIEVED',
      excerpt: null,
    },
  }),
  candidate({
    id: 'CAND-CODE12-ELECTRONIC-PAYMENT',
    kind: 'CONTRAVENTION_METADATA',
    proposition:
      'The general suffix "u" denotes electronic payment.',
    reviewQuestion:
      'Open the London Councils suffix table and confirm that "u" is a general suffix denoting electronic payment, and that it may be used with code 12. Record the exact table wording. Reject if the suffix is code-specific rather than general, or denotes something else.',
    doesNotEstablish: [
      'That a valid parking session existed. The suffix records the payment method alleged, not that payment succeeded.',
      'That any payment covered the correct vehicle, the correct location, or the correct period.',
      'That the notice is cancelled, or must be cancelled, because the suffix is present.',
      'Any statutory ground, and in particular not the ground concerning payment of the penalty charge.',
      'How an enforcement officer verifies electronic payment or virtual permit status against a registration. That mechanism is not established by this candidate and would need its own, from a source that states it.',
    ],
    applicability: {
      contraventionCodes: null,
      authoritySlug: null,
      noticeTypes: null,
      proceduralStages: null,
      conditions: [
        'London local-authority parking PCNs only.',
        'A general suffix is not confined to one code, so the reviewer should confirm its scope rather than assume this bundle\u2019s code-12 framing.',
      ],
    },
    source: {
      organisation: 'London Councils',
      documentTitle: 'Parking contravention codes used by London enforcement authorities',
      canonicalUrl: LONDON_COUNCILS_CODES,
      jurisdiction: 'ENGLAND_LONDON',
      provision: 'General suffix table, suffix "u"',
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
    /*
     * Not STATUTORY_GROUND, though it is about them.
     *
     * "Schedule 1 sets out an exhaustive list of grounds" is a statement about
     * the framework, not a ground anybody can rely on. Left as STATUTORY_GROUND
     * it would satisfy `hasApprovedStatutoryGround` on approval, so confirming
     * that a list exists would turn on legal drafting for a case where no
     * individual ground had been reviewed at all.
     */
    kind: 'STATUTORY_GROUND_INTERPRETATION',
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
      `Confirm the exact statutory wording of this ground and record it verbatim. Check ${REGS_2022_TITLE} as well as the enabling Act — the representations and appeals regime is now set out in that instrument, and its SI number must be located and recorded here before approval. This is the only ground the paid-by-app scenario would plausibly engage, so its wording matters more than any other candidate in this bundle.`,
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
    /*
     * The most important classification in this file.
     *
     * This proposition exists to STOP PCNWatch saying something. Classified as
     * STATUTORY_GROUND, approving it would satisfy
     * `hasApprovedStatutoryGround` and switch statutory drafting on — a guard
     * that unlocks the thing it guards. As an interpretation it can never do
     * that, however it is worded and whoever approves it.
     */
    kind: 'STATUTORY_GROUND_INTERPRETATION',
    proposition:
      'The statutory ground that the penalty charge has already been paid refers to payment of the penalty charge itself, and not to payment of the underlying parking charge.',
    reviewQuestion:
      'Confirm the wording of the payment-related ground. PCNWatch holds a record keyed GROUND-ALREADY_PAID; check whether it describes payment of the penalty or payment for parking. If it conflates the two, REJECT the existing record — a user who paid by app has not paid the penalty, and telling them otherwise would send a representation on a ground that does not apply.',
    doesNotEstablish: [
      'That paying for parking engages any ground. A user saying "I paid for parking" must never reach GROUND-ALREADY_PAID.',
      'That paying for parking is irrelevant. It is a factual matter, which is where PCNWatch already puts it.',
      'Any ground at all. This narrows a ground; approving it never makes one available.',
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
  candidate({
    id: 'CAND-MITIGATION-SEPARATE',
    kind: 'PROCEDURE',
    proposition:
      'A motorist may ask an enforcement authority to consider mitigating circumstances even where no statutory ground of representation is established.',
    reviewQuestion:
      `Confirm that asking an authority to exercise discretion is available independently of the statutory grounds, and identify where that is stated \u2014 ${REGS_2022_TITLE}, the statutory guidance, or the authority's own published policy. Record which. Reject if mitigation is only available as an adjunct to a statutory ground.`,
    doesNotEstablish: [
      'That mitigation is a statutory ground. It is the opposite: this candidate exists to hold the two apart.',
      'That an authority must consider mitigation, or must cancel where it does.',
      'That an adjudicator has the same discretion an authority has. An adjudicator\u2019s powers are narrower and that is a separate proposition.',
      'That the contravention did not occur.',
    ],
    applicability: {
      contraventionCodes: null,
      authoritySlug: null,
      noticeTypes: null,
      proceduralStages: null,
      conditions: [
        'This is the route the Westminster paid-by-app scenario actually takes today: facts and a request to reconsider, with no ground asserted.',
      ],
    },
    source: {
      organisation: 'UK Parliament (legislation.gov.uk)',
      documentTitle: REGS_2022_TITLE,
      canonicalUrl: LEGISLATION_UKSI_2022,
      jurisdiction: 'ENGLAND_LONDON',
      provision:
        'To be identified: the SI number and the provision (or the statutory guidance paragraph) under which discretion is exercised',
      tier: 'STATUTORY_INSTRUMENT',
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
      'Westminster City Council states that discretion can be exercised where a motorist made an honest attempt to park legally and correctly but made a genuine mistake.',
    reviewQuestion:
      'Confirm whether Westminster publishes such a policy and record its actual terms and any stated conditions. This is the proposition closest to the paid-by-app scenario and the easiest to overstate: confirm the words, and confirm they describe discretion rather than entitlement.',
    doesNotEstablish: [
      'That a mistaken registration entry is a genuine mistake within the policy. That is the authority\u2019s judgement on the facts, not something this proposition decides.',
      'That cancellation is mandatory, or that the policy obliges Westminster to cancel anything.',
      'That any particular result is guaranteed.',
      'That an adjudicator would take the same view. An adjudicator\u2019s powers are narrower than an authority\u2019s discretion.',
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
      'Westminster City Council states that relevant evidence should be considered, and that decisions should be based on the weight of the evidence.',
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
  candidate({
    id: 'CAND-DEADLINE-APPEAL-28D',
    kind: 'DEADLINE_RULE',
    proposition:
      'An appeal against the rejection of representations is ordinarily made within 28 days beginning with the date of service of the notice of rejection, subject to any longer period the adjudicator allows.',
    reviewQuestion:
      `Confirm the period, the event it runs from, whether it is "beginning with" or "from" that date, and how service is deemed to occur. Locate and record the SI number of ${REGS_2022_TITLE} and the regulation. Cross-check against London Tribunals' published guidance, but do not approve on the strength of the guidance alone \u2014 a tribunal page is competent about how the tribunal runs, not about what the instrument says.`,
    doesNotEstablish: [
      'Any period for making representations, or any discount period. Those are separate rules with separate triggers and separate candidates.',
      'That an appeal made outside the period will be refused. The adjudicator may allow a longer period, and PCNWatch must not tell anybody their appeal is out of time.',
      'The date on any particular notice of rejection.',
      'Any statutory ground, or anything about the merits of an appeal.',
    ],
    applicability: {
      contraventionCodes: null,
      authoritySlug: null,
      noticeTypes: ['NOTICE_OF_REJECTION'],
      proceduralStages: ['NOTICE_OF_REJECTION', 'TRIBUNAL_ELIGIBLE', 'TRIBUNAL_APPEAL'],
      conditions: [
        'London civil parking enforcement.',
        'Independently reviewable: approving this rule must not release any other deadline, and approving any other deadline must not release this one.',
      ],
    },
    source: {
      organisation: 'UK Parliament (legislation.gov.uk)',
      documentTitle: REGS_2022_TITLE,
      canonicalUrl: LEGISLATION_UKSI_2022,
      jurisdiction: 'ENGLAND_LONDON',
      provision: 'To be identified: the SI number and the regulation fixing the appeal period',
      tier: 'STATUTORY_INSTRUMENT',
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
