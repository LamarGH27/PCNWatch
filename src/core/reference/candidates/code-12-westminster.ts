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
/**
 * The exact page the three policy propositions come from.
 *
 * Previously the parking hub, which is a navigation page: a reviewer opening it
 * would have had to find the policy themselves, and two of them might have
 * found different pages. Each candidate now names the heading its proposition
 * sits under, so the review is "does the page say this, under this heading"
 * rather than "is this the sort of thing Westminster says".
 */
const WESTMINSTER_CHALLENGE =
  'https://www.westminster.gov.uk/parking/challenge-your-parking-ticket/consideration-parking-ticket-challenges';

/*
 * The 2022 Regulations, now with their SI number.
 *
 * The instrument was previously named by title only: I did not have the number
 * to a standard I would put in a URL a reviewer would trust, and a wrong
 * legislation.gov.uk link looks exactly like a checked one. The number was
 * supplied with the review instructions, so the canonical URL now points at the
 * instrument rather than at the enabling Act.
 *
 * It is still NOT_RETRIEVED. Knowing where a document lives is not the same as
 * having read it, and the excerpt stays null until a reviewer opens it.
 */
const REGS_2022_TITLE =
  'The Civil Enforcement of Road Traffic Contraventions (Representations and Appeals) (England) Regulations 2022';
const REGS_2022_SI = 'S.I. 2022/576';
const REGS_2022_URL = 'https://www.legislation.gov.uk/uksi/2022/576';

/**
 * London Tribunals — the adjudicator's own published explanation of the
 * process. Competent about how an appeal runs; never about what the law says,
 * which is why the TRIBUNAL tier may establish PROCEDURE and nothing else.
 */
const LONDON_TRIBUNALS = 'https://www.londontribunals.gov.uk/';

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
      'For permit contraventions including codes 01, 12, 16, 19 and 85, the code-specific suffix "x" means an incorrect vehicle registration mark.',
    reviewQuestion:
      'Open the London Councils code and suffix framework and confirm that "x" is a code-specific suffix meaning incorrect VRM, and that it is in current use with each of codes 01, 12, 16, 19 and 85. Record the exact table wording. Reject if the suffix has been withdrawn, if it means something different for any of those codes, or if the list of codes it applies to is not as stated — a suffix that means one thing on code 12 and another on code 19 is two propositions, not one.',
    doesNotEstablish: [
      'That payment was made. The suffix records what the authority alleges about the registration, not what the motorist did.',
      'That the contravention did not occur. Whether it occurred is a question of fact for the authority and, on appeal, the adjudicator.',
      'That the notice must be cancelled, or that cancellation follows from the suffix being present.',
      'Any statutory ground of representation or appeal.',
      'That the authority is obliged to search for a payment made against a different registration.',
    ],
    applicability: {
      contraventionCodes: ['01', '12', '16', '19', '85'],
      authoritySlug: null,
      noticeTypes: null,
      proceduralStages: null,
      conditions: [
        'London local-authority parking PCNs only.',
        'Permit contraventions only. The suffix is code-specific, so its meaning outside codes 01, 12, 16, 19 and 85 is not covered by this candidate.',
        'PCNWatch currently declines to interpret a suffix at all and says so. This candidate exists to replace that silence with one enumerated meaning, not to license inference from it.',
      ],
    },
    source: {
      organisation: 'London Councils',
      documentTitle: 'Parking contravention codes used by London enforcement authorities',
      canonicalUrl: LONDON_COUNCILS_CODES,
      jurisdiction: 'ENGLAND_LONDON',
      provision: 'Code-specific suffix table — suffix "x" (codes 01, 12, 16, 19, 85)',
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
      'Open the London Councils code and suffix framework and confirm that "u" is a general suffix denoting electronic payment. Record the exact table wording. Reject if it is code-specific rather than general, or denotes something else. Note for the record which codes a general suffix may accompany.',
    doesNotEstablish: [
      'That a valid parking session existed. The suffix records the payment method involved, not that payment succeeded.',
      'That any payment was made against the correct vehicle.',
      'That any payment covered the correct location.',
      'That any payment covered the correct time or period.',
      'Any entitlement to cancellation, and any statutory ground — in particular not the ground concerning payment of the penalty charge.',
      'How an enforcement officer verifies electronic payment or virtual permit status against a registration. That mechanism would need its own candidate, from a source that states it.',
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
      'The statutory grounds of representation apply to representations made against an enforcement notice — a Notice to Owner or a regulation 10 penalty charge notice — and not to an informal challenge made before one has been served.',
    reviewQuestion:
      `Re-sourced from the Act to the instrument, and reworded. It previously said the grounds attach to a Notice to Owner, sourced to Traffic Management Act 2004 Schedule 1. Under ${REGS_2022_SI} representations are made against an *enforcement notice*, which is a Notice to Owner OR a regulation 10 penalty charge notice — so the old wording excluded every postal PCN. Confirm from regulation 5 which document representations attach to and how "enforcement notice" is defined, and record both verbatim. Also confirm the relationship between Schedule 1 and these Regulations — whether Schedule 1 remains the enabling provision, has been amended, or is simply the wrong place to look for this. This governs every other statutory candidate in the bundle: if the scope is wrong, they are all scoped wrongly.`,
    doesNotEstablish: [
      'That an informal challenge is pointless or that an authority will not consider one.',
      'The content of any individual ground.',
      'That the grounds attach to a regulation 9 windscreen PCN. They do not; that stage is the informal challenge.',
    ],
    applicability: {
      contraventionCodes: null,
      authoritySlug: null,
      noticeTypes: ['NOTICE_TO_OWNER', 'PCN_POSTAL'],
      proceduralStages: ['NEW', 'NOTICE_TO_OWNER', 'FORMAL_REPRESENTATION'],
      conditions: [
        'Applies to an enforcement notice: a Notice to Owner, or a regulation 10 (postal) penalty charge notice.',
        'Not the regulation 9 windscreen PCN at the informal challenge stage.',
      ],
    },
    source: {
      organisation: 'UK Parliament (legislation.gov.uk)',
      documentTitle: `${REGS_2022_TITLE} (${REGS_2022_SI})`,
      canonicalUrl: REGS_2022_URL,
      jurisdiction: 'ENGLAND_LONDON',
      provision: 'Regulation 5 — representations against an enforcement notice',
      tier: 'STATUTORY_INSTRUMENT',
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
      'Regulation 5 sets out an exhaustive list of grounds on which representations against an enforcement notice may be made.',
    reviewQuestion:
      `Re-sourced from Traffic Management Act 2004 Schedule 1 to ${REGS_2022_SI} regulation 5, because that is where the grounds for representations now sit and pointing a reviewer at the Act would have them reading the enabling provision rather than the list. Enumerate the grounds as currently in force and confirm the list is exhaustive. PCNWatch holds eight ground records written before any review; check each against regulation 5 and record which are correctly stated, which need rewording, and which do not exist. Confirm at the same time whether Schedule 1 is superseded, amended, or still the parent provision for these Regulations — I could not open either document and the relationship between them is assumed, not checked.`,
    doesNotEstablish: [
      'The wording of any individual ground.',
      'That any ground is available on the facts of any case.',
      'That an authority must accept a representation made on a listed ground.',
    ],
    applicability: {
      contraventionCodes: null,
      authoritySlug: null,
      noticeTypes: ['NOTICE_TO_OWNER', 'PCN_POSTAL'],
      proceduralStages: ['NEW', 'NOTICE_TO_OWNER', 'FORMAL_REPRESENTATION'],
      conditions: [
        'Applies to an enforcement notice: a Notice to Owner, or a regulation 10 (postal) penalty charge notice.',
        'Not the regulation 9 windscreen PCN at the informal challenge stage.',
      ],
    },
    source: {
      organisation: 'UK Parliament (legislation.gov.uk)',
      documentTitle: `${REGS_2022_TITLE} (${REGS_2022_SI})`,
      canonicalUrl: REGS_2022_URL,
      jurisdiction: 'ENGLAND_LONDON',
      provision: 'Regulation 5 — grounds for representations',
      tier: 'STATUTORY_INSTRUMENT',
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
      'That the contravention did not occur is a statutory ground of representation and of appeal for a parking penalty charge notice.',
    reviewQuestion:
      `Open ${REGS_2022_SI} and record the exact statutory wording of this ground, verbatim, together with the regulation and paragraph it sits in. London Tribunals' published grounds of appeal (${LONDON_TRIBUNALS}) is a useful cross-check on how the ground is described in practice, but do not approve on the strength of it: a tribunal page is competent about how the tribunal runs, not about what the instrument says. This is the only ground the paid-by-app scenario would plausibly engage, so its wording matters more than any other candidate in this bundle.`,
    doesNotEstablish: [
      'That the ground is available on the facts of any particular case. It must never be asserted merely because a user says "I paid for parking" or "I used RingGo" — those are accounts of what happened, and whether they mean the contravention did not occur is a question of fact for the authority and, on appeal, the adjudicator.',
      'That a payment made against a different registration means the contravention did not occur.',
      'That raising this ground obliges an authority to cancel.',
      'Any view about how likely the ground is to succeed.',
    ],
    applicability: {
      contraventionCodes: null,
      authoritySlug: null,
      /*
       * An enforcement notice, not a Notice to Owner.
       *
       * These were scoped to NOTICE_TO_OWNER alone, which is narrower than the
       * statute: S.I. 2022/576 attaches representations to an *enforcement
       * notice*, and that is a Notice to Owner OR a regulation 10 penalty
       * charge notice. A regulation 10 PCN is the one served by post — the
       * camera and CCTV route — and the recipient makes representations
       * against it directly, with no Notice to Owner in between. Scoped to the
       * NtO only, the ground would have been unavailable to every postal PCN.
       *
       * PCN_POSTAL is the application's existing name for that document; no
       * new enum member is needed, and inventing one would give the codebase
       * two names for one notice.
       *
       * PCN_ON_STREET stays out. That is the regulation 9 windscreen PCN,
       * which precedes the enforcement notice — a challenge at that point is
       * informal, and the statutory grounds do not yet apply to it.
       */
      noticeTypes: ['NOTICE_TO_OWNER', 'PCN_POSTAL'],
      /*
       * NEW is here for the regulation 10 PCN, which has no earlier stage: it
       * arrives as the enforcement notice. The notice type is what carries the
       * statutory scope, and the stage list must not be narrower than it.
       */
      proceduralStages: ['NEW', 'NOTICE_TO_OWNER', 'FORMAL_REPRESENTATION'],
      conditions: [
        'Applies to an enforcement notice: a Notice to Owner, or a regulation 10 (postal) penalty charge notice.',
        'Not the regulation 9 windscreen PCN at the informal challenge stage.',
      ],
    },
    source: {
      organisation: 'UK Parliament (legislation.gov.uk)',
      documentTitle: `${REGS_2022_TITLE} (${REGS_2022_SI})`,
      canonicalUrl: REGS_2022_URL,
      jurisdiction: 'ENGLAND_LONDON',
      provision: 'To be identified by the reviewer: the regulation and paragraph stating this ground',
      tier: 'STATUTORY_INSTRUMENT',
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
      'The statutory ground that the penalty charge has already been paid refers to payment of the penalty charge itself, not payment for the underlying parking session.',
    reviewQuestion:
      'Confirm the wording of the payment-related ground. PCNWatch holds a record keyed GROUND-ALREADY_PAID; check whether it describes payment of the penalty or payment for parking. If it conflates the two, REJECT the existing record — a user who paid by app has not paid the penalty, and telling them otherwise would send a representation on a ground that does not apply.',
    doesNotEstablish: [
      'That paying for parking engages any ground. A user saying "I paid for parking" must never reach GROUND-ALREADY_PAID.',
      'That paying for parking is irrelevant. It is a factual matter, which is where PCNWatch already puts it.',
      'Any ground at all. This narrows a ground; approving it never makes one available. It is classified STATUTORY_GROUND_INTERPRETATION precisely so that it can never satisfy `hasApprovedStatutoryGround` and therefore can never itself enable `canStateGrounds`.',
    ],
    applicability: {
      contraventionCodes: null,
      authoritySlug: null,
      /*
       * An enforcement notice, not a Notice to Owner.
       *
       * These were scoped to NOTICE_TO_OWNER alone, which is narrower than the
       * statute: S.I. 2022/576 attaches representations to an *enforcement
       * notice*, and that is a Notice to Owner OR a regulation 10 penalty
       * charge notice. A regulation 10 PCN is the one served by post — the
       * camera and CCTV route — and the recipient makes representations
       * against it directly, with no Notice to Owner in between. Scoped to the
       * NtO only, the ground would have been unavailable to every postal PCN.
       *
       * PCN_POSTAL is the application's existing name for that document; no
       * new enum member is needed, and inventing one would give the codebase
       * two names for one notice.
       *
       * PCN_ON_STREET stays out. That is the regulation 9 windscreen PCN,
       * which precedes the enforcement notice — a challenge at that point is
       * informal, and the statutory grounds do not yet apply to it.
       */
      noticeTypes: ['NOTICE_TO_OWNER', 'PCN_POSTAL'],
      /*
       * NEW is here for the regulation 10 PCN, which has no earlier stage: it
       * arrives as the enforcement notice. The notice type is what carries the
       * statutory scope, and the stage list must not be narrower than it.
       */
      proceduralStages: ['NEW', 'NOTICE_TO_OWNER', 'FORMAL_REPRESENTATION'],
      conditions: [
        'Applies to an enforcement notice: a Notice to Owner, or a regulation 10 (postal) penalty charge notice.',
        'Not the regulation 9 windscreen PCN at the informal challenge stage.',
      ],
    },
    source: {
      organisation: 'UK Parliament (legislation.gov.uk)',
      documentTitle: `${REGS_2022_TITLE} (${REGS_2022_SI})`,
      canonicalUrl: REGS_2022_URL,
      jurisdiction: 'ENGLAND_LONDON',
      provision: 'To be identified by the reviewer: the regulation stating the payment ground',
      tier: 'STATUTORY_INSTRUMENT',
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
      'A motorist may ask the enforcement authority to consider mitigation even where no statutory ground is established.',
    reviewQuestion:
      `Open ${REGS_2022_SI} regulation 5(2)(b)(i) and (ii) and confirm that a person may put circumstances to the authority alongside, or independently of, the grounds — and record the wording verbatim. London Tribunals (${LONDON_TRIBUNALS}) describes the same thing in practice and is a useful cross-check, but it is not the source: a tribunal page is competent about how the tribunal runs, not about what the instrument says. Reject if mitigation turns out to be available only as an adjunct to an established ground.`,
    doesNotEstablish: [
      'That mitigation is a statutory ground. It is the opposite: this candidate exists to hold the two apart, and it is classified PROCEDURE so that approving it can never make a ground available.',
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
      documentTitle: `${REGS_2022_TITLE} (${REGS_2022_SI})`,
      canonicalUrl: REGS_2022_URL,
      jurisdiction: 'ENGLAND_LONDON',
      provision: 'Regulation 5(2)(b)(i) and (ii)',
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
      'Westminster City Council states that the circumstances surrounding a particular PCN are unique and each PCN should be considered on its own merits.',
    reviewQuestion:
      'Find and confirm the published Westminster statement to this effect, and record where it appears. If Westminster publishes no such statement, REJECT rather than substituting a general expectation about how authorities behave.',
    doesNotEstablish: [
      'Any statutory right to cancellation. The council saying it will look at a case on its merits is a statement about how it decides, not about what a motorist is entitled to.',
      'That Westminster will cancel any particular notice, or that a challenge on the merits will succeed.',
      'That an adjudicator applies the same approach. An adjudicator\u2019s powers are narrower than an authority\u2019s discretion.',
      'Any statutory ground of representation or appeal.',
      'That any other authority says or does the same.',
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
      documentTitle: 'Consideration of parking ticket challenges',
      canonicalUrl: WESTMINSTER_CHALLENGE,
      jurisdiction: 'ENGLAND_LONDON',
      provision: 'Merits of the case',
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
      'Westminster City Council states that discretion can be given where it is evident that the motorist made an honest attempt to park legally and correctly but made a genuine mistake and incurred the PCN in doing so.',
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
      documentTitle: 'Consideration of parking ticket challenges',
      canonicalUrl: WESTMINSTER_CHALLENGE,
      jurisdiction: 'ENGLAND_LONDON',
      provision: 'Genuine mistakes, mitigation and discretion',
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
      'Westminster City Council states that all relevant evidence should be fully considered and decisions should be based on the weight of the evidence.',
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
      documentTitle: 'Consideration of parking ticket challenges',
      canonicalUrl: WESTMINSTER_CHALLENGE,
      jurisdiction: 'ENGLAND_LONDON',
      provision: "Full consideration of evidence and the 'balance of probabilities'",
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
      'An appeal against a decision rejecting representations must ordinarily be made within 28 days beginning with the date of service of the decision notice, or such longer period as the adjudicator may allow.',
    reviewQuestion:
      `Open ${REGS_2022_SI} regulation 7(2) and confirm the period, the event it runs from, that it is "beginning with" rather than "from" that date, and how service is deemed to occur for each service method. Record the wording verbatim. Cross-check against London Tribunals (${LONDON_TRIBUNALS}), but do not approve on the strength of the tribunal page alone. Approving this candidate does NOT release a calculated date to users: the deadline projection reads its own rule store, and that rule needs its own review.`,
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
        'Separate from the deadline projection. `projectDeadlines` gates on its own rule store, so approving this candidate does not by itself put a calculated date in front of a user.',
      ],
    },
    source: {
      organisation: 'UK Parliament (legislation.gov.uk)',
      documentTitle: `${REGS_2022_TITLE} (${REGS_2022_SI})`,
      canonicalUrl: REGS_2022_URL,
      jurisdiction: 'ENGLAND_LONDON',
      provision: 'Regulation 7(2)',
      tier: 'STATUTORY_INSTRUMENT',
      documentDate: null,
      retrievedAt: null,
      retrieval: 'NOT_RETRIEVED',
      excerpt: null,
    },
  }),
];

/**
 * The nine propositions the first review sitting has to get through.
 *
 * Ordered as the review instructions set them out, not as the file happens to
 * be arranged, because the order is itself a decision: the two suffix meanings
 * before the policies, the statutory ground before the interpretation that
 * narrows it, and the deadline last because approving it releases nothing on
 * its own.
 *
 * The other five candidates in the bundle are real and still need deciding.
 * They are not in this list because none of them is on the critical path to a
 * Defence Pack for the launch scenario, and putting fourteen things in front of
 * a reviewer when nine of them are the point is how the nine get skimmed.
 */
export const INITIAL_LAUNCH_REVIEW: readonly string[] = [
  // The code itself comes first. A suffix modifies a contravention, so
  // reviewing what "x" means before confirming what code 12 alleges is
  // reviewing an adjective without the noun.
  'CAND-CODE12-DEFINITION',
  'CAND-CODE12-SUFFIXES',
  'CAND-CODE12-ELECTRONIC-PAYMENT',
  'CAND-WCC-INDIVIDUAL-MERITS',
  'CAND-WCC-GENUINE-MISTAKE',
  'CAND-WCC-EVIDENCE-CONSIDERED',
  'CAND-TMA-GROUND-NO-CONTRAVENTION',
  'CAND-TMA-GROUND-PAID-DISTINCTION',
  'CAND-MITIGATION-SEPARATE',
  'CAND-DEADLINE-APPEAL-28D',
];

export const CODE_12_WESTMINSTER_BUNDLE: readonly CandidateProposition[] = [
  ...CONTRAVENTION,
  ...STATUTORY,
  ...POLICY,
  ...DEADLINES,
];
