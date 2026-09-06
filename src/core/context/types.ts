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

/** Whether the user says a thing was so. Never more granular than this. */
export type AnswerValue = 'YES' | 'NO' | 'UNSURE';

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
}

export const EMPTY_USER_CONTEXT: UserContext = {
  narrativeProvided: false,
  answers: [],
  declaredEvidence: [],
};
