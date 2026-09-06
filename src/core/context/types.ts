import type { EvidenceType } from '../evidence/types';

/**
 * What the user tells us about their own case.
 *
 * Three kinds of thing live here and they are deliberately never merged,
 * because they carry completely different weight:
 *
 *   - what the user SAYS happened (their account, and their answers)
 *   - what the user HOLDS (evidence they say they can produce)
 *   - what PCNWatch FINDS (the deterministic assessment, elsewhere)
 *
 * Collapsing the first into the third is how a product starts inventing
 * defences. An answer of "yes, I had a permit" is a claim we record, not a fact
 * we assert and not a ground we argue.
 */

/**
 * What the user said about a question — including not having said anything.
 *
 * UNANSWERED is a value rather than an absence, and that distinction caused a
 * real bug: two representations of "we do not know" existed (a missing key and
 * a recorded NOT_SURE), only one of them was reachable by reading the answer,
 * and code that wanted to ask "did they say no?" had to remember which. Making
 * it explicit means every place that handles an answer has to decide what to do
 * with an untouched question, and none of them can decide it means "no".
 */
export const ANSWER_VALUES = ['YES', 'NO', 'NOT_SURE', 'UNANSWERED'] as const;
export type AnswerValue = (typeof ANSWER_VALUES)[number];

/** The answers that say something. UNANSWERED never reaches a finding. */
export function isDefiniteAnswer(answer: AnswerValue): answer is 'YES' | 'NO' {
  return answer === 'YES' || answer === 'NO';
}

/** Whether the user says they can produce a piece of evidence. */
export type EvidenceHeld = 'HAVE' | 'DO_NOT_HAVE' | 'NOT_SURE';

export type QuestionSource = 'CONTRAVENTION_REFERENCE' | 'GENERAL_GUIDANCE';

export interface ContextQuestion {
  /** Stable across renders and safe to send to the server. Carries no personal data. */
  readonly id: string;
  /** The question, as the reference store words it. */
  readonly prompt: string;
  readonly source: QuestionSource;
  /**
   * The approved records that justify asking. Never empty: a question with
   * nothing behind it is a question PCNWatch invented, and `selectContextQuestions`
   * will not emit one.
   */
  readonly referenceKeys: readonly string[];
  /**
   * What answering this makes worth checking. Used to explain why we asked, and
   * never treated as evidence the user actually holds.
   */
  readonly relatedEvidence: readonly EvidenceType[];
  /**
   * True when a YES describes mitigation rather than a challenge to the facts.
   * Mitigation asks an authority to exercise discretion; it does not establish
   * that the contravention did not occur, and the two must not read alike.
   */
  readonly isMitigation: boolean;
}

/** A piece of evidence we are asking the user whether they hold. */
export interface EvidenceQuestion {
  readonly type: EvidenceType;
  readonly label: string;
  /** Why this case in particular calls for it. */
  readonly reason: string;
  readonly referenceKeys: readonly string[];
  readonly essential: boolean;
}

export interface ContextAnswer {
  readonly questionId: string;
  readonly answer: AnswerValue;
}

export interface EvidenceDeclaration {
  readonly type: EvidenceType;
  readonly held: EvidenceHeld;
}

/**
 * The user's context, as it reaches the assessment.
 *
 * `narrativeProvided` is a boolean rather than the text. The narrative may
 * contain a name, an address, a medical detail or a registration, no
 * deterministic rule can read free prose anyway, and there is nowhere
 * authenticated to put it yet — so the text stays in the browser and only the
 * fact that it exists crosses to the server.
 */
export interface UserContext {
  readonly narrativeProvided: boolean;
  readonly answers: readonly ContextAnswer[];
  readonly declaredEvidence: readonly EvidenceDeclaration[];
  /**
   * Facts read out of the account that the user then confirmed.
   *
   * Only confirmed ones exist at this point in the system. An extraction the
   * user has not looked at never becomes a member of this list, so there is no
   * state in which unreviewed model output is sitting in the assessment's input
   * waiting to be filtered out by something remembering to.
   */
  readonly confirmedAssertions: readonly ConfirmedAssertion[];
  /**
   * Facts the user settled after being shown that their two answers disagreed.
   *
   * A resolution overrides both sources for that topic. It exists because the
   * alternative — picking whichever source the code happened to read last — is
   * how a case file ends up asserting two incompatible things about the same
   * afternoon.
   */
  readonly resolvedFacts: readonly ResolvedFact[];
}

/**
 * A contradiction the user has settled.
 *
 * Deliberately just a topic and a stance. The point of resolution is that one
 * answer now stands; carrying the losing one forward as data would invite
 * something downstream to display it again.
 */
export interface ResolvedFact {
  readonly topic: NarrativeAssertionKind;
  readonly stance: NarrativeStance;
}

export const EMPTY_USER_CONTEXT: UserContext = {
  narrativeProvided: false,
  answers: [],
  declaredEvidence: [],
  confirmedAssertions: [],
  resolvedFacts: [],
};

/* ------------------------------------------------------------------ */
/* What a written account can be reduced to                            */
/* ------------------------------------------------------------------ */

/**
 * The closed set of factual claims an account may be turned into.
 *
 * Closed is the mechanism, not a convenience. A model reading "I had a permit
 * and this ticket is outrageous" must have somewhere to put the permit and
 * nowhere to put the outrage-as-law: there is no member here for a defence, a
 * ground, an invalid notice or an outcome, so it cannot return one however the
 * account was phrased.
 *
 * Every member states something that happened, never what follows from it.
 * Whether holding a permit means the contravention did not occur is a question
 * for the reference store and the deterministic engine, and it is not asked here.
 *
 * Lives in core rather than beside the model schema because both sides need it:
 * the server constrains the model to it, and the browser renders it back for
 * confirmation. One list, so the two cannot drift.
 */
export const NARRATIVE_ASSERTION_KINDS = [
  'HELD_PERMIT',
  'PERMIT_VALID',
  'PAYMENT_MADE',
  'PAYMENT_BY_APP',
  'WRONG_VRM_POSSIBLE',
  'LOADING_OR_UNLOADING',
  'SIGNAGE_UNCLEAR_OR_NOT_SEEN',
  'BAY_MARKINGS_UNCLEAR',
  'VEHICLE_BROKE_DOWN',
  'BLUE_BADGE_PRESENT',
  'AUTHORITY_PHOTOGRAPHS_REVIEWED',
  'MITIGATING_CIRCUMSTANCES',
  /**
   * The escape hatch, and it must stay one.
   *
   * Something the user plainly meant that no member above covers goes here with
   * a neutral summary, for a person to look at later. Forcing it into the
   * nearest member would be worse than not capturing it at all: "I was at the
   * hospital with my mother" is not "the vehicle broke down", and a near-miss
   * reads back as a fact the user never stated.
   */
  'OTHER_REQUIRES_REVIEW',
] as const;

export type NarrativeAssertionKind = (typeof NARRATIVE_ASSERTION_KINDS)[number];

/** What the account says about it. Never what we conclude from it. */
export const NARRATIVE_STANCES = ['ASSERTED', 'DENIED', 'UNCLEAR'] as const;
export type NarrativeStance = (typeof NARRATIVE_STANCES)[number];

/** Plain-English labels for the confirmation screen. */
export const ASSERTION_LABELS: Record<NarrativeAssertionKind, string> = {
  HELD_PERMIT: 'You held a permit',
  PERMIT_VALID: 'The permit was valid at the time',
  PAYMENT_MADE: 'You paid to park',
  PAYMENT_BY_APP: 'You paid using an app',
  WRONG_VRM_POSSIBLE: 'The wrong registration may have been entered',
  LOADING_OR_UNLOADING: 'You were loading or unloading',
  SIGNAGE_UNCLEAR_OR_NOT_SEEN: 'The signs were unclear or you did not see them',
  BAY_MARKINGS_UNCLEAR: 'The bay markings were unclear',
  VEHICLE_BROKE_DOWN: 'Your vehicle broke down',
  BLUE_BADGE_PRESENT: 'A Blue Badge was displayed',
  AUTHORITY_PHOTOGRAPHS_REVIEWED: 'You have looked at the authority\u2019s photographs',
  MITIGATING_CIRCUMSTANCES: 'There were exceptional circumstances',
  OTHER_REQUIRES_REVIEW: 'Something else you told us',
};

/**
 * One factual claim read out of the account.
 *
 * `source` is always USER_ACCOUNT and is stamped server-side rather than taken
 * from the model — "where did this come from" is the one field that must never
 * be wrong, so nothing that could be wrong about it is asked to fill it in.
 */
export interface NarrativeAssertion {
  readonly kind: NarrativeAssertionKind;
  readonly stance: NarrativeStance;
  readonly confidence: number;
  /** A short neutral restatement, attributed to the user. Shown for confirmation. */
  readonly summary: string;
  readonly source: 'USER_ACCOUNT';
}

/**
 * An assertion the user has looked at and accepted.
 *
 * A separate type from `NarrativeAssertion` on purpose. An extracted assertion
 * is a machine's reading of prose; a confirmed one is something a person said
 * is right. Only the second may reach the assessment, and giving them different
 * types means a caller has to do something deliberate to confuse them.
 */
export interface ConfirmedAssertion {
  readonly kind: NarrativeAssertionKind;
  readonly stance: NarrativeStance;
}
