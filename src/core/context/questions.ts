import type { EvidenceType } from '../evidence/types';
import { buildEvidenceRequirements } from '../evidence/checklist';
import { EVIDENCE_DEFINITIONS } from '../evidence/definitions';
import {
  getContravention,
  getReference,
  referencesByCategory,
} from '../reference/store';
import type { NoticeType, ProceduralStage } from '../reference/types';
import type { ContextQuestion, EvidenceQuestion } from './types';

/**
 * Which questions to ask this user about this notice.
 *
 * There is no questionnaire in this file. Every contravention-specific question
 * is read out of the approved reference record for the code the user verified —
 * `commonFactualQuestions`, which already exists and is already reviewed as part
 * of that record — so the set changes per code without anyone maintaining a
 * parallel list, and a code we hold no record for produces no specific questions
 * at all rather than plausible-sounding ones.
 *
 * The general questions are few, deliberately, and each cites a real record.
 * `emit` drops any question whose citations do not resolve, so a question with
 * nothing behind it cannot reach a user even if someone adds one here by
 * mistake.
 *
 * Asking is not asserting. A question is a question: answering "yes" to "did you
 * hold a permit?" records a claim, and nothing in this module or downstream
 * turns that claim into a statutory ground.
 */

/** How many factual questions the first pass may ask. */
const MAX_FACTUAL_QUESTIONS = 6;
/** How many evidence declarations the first pass may ask for. */
const MAX_EVIDENCE_QUESTIONS = 6;

export interface QuestionSelectionInput {
  /** Canonical contravention code the user verified, or null. */
  readonly contraventionCode: string | null;
  readonly noticeType: NoticeType;
  readonly proceduralStage: ProceduralStage;
  /** Evidence already uploaded. We do not ask whether they hold what we have. */
  readonly evidenceProvided?: Partial<Record<EvidenceType, number>>;
  /** Question ids already answered, so a second pass does not repeat itself. */
  readonly answeredQuestionIds?: readonly string[];
  /** Evidence types already declared, for the same reason. */
  readonly declaredEvidenceTypes?: readonly EvidenceType[];
}

export interface ContextQuestionSet {
  readonly questions: readonly ContextQuestion[];
  readonly evidenceQuestions: readonly EvidenceQuestion[];
  /**
   * Set when we hold no reference record for the code on the notice. The UI says
   * so plainly instead of quietly asking nothing.
   */
  readonly unknownContraventionCode: string | null;
}

const GENERAL_PREFIX = 'GENERAL';

/**
 * Questions that hold whatever the contravention is.
 *
 * Defined once and read by both the selector and the prompt resolver, so the
 * wording a user is asked and the wording quoted back at them in the assessment
 * cannot drift apart. Each cites a real record; `referenceKeys` here is the
 * default, and the selector may narrow it to something more specific.
 */
const GENERAL_QUESTIONS = {
  COUNCIL_PHOTOGRAPHS: {
    id: `${GENERAL_PREFIX}#council-photographs`,
    prompt: 'Have you looked at the photographs the authority took?',
    source: 'GENERAL_GUIDANCE',
    referenceKeys: ['PROCEDURE-NEW'],
    relatedEvidence: ['COUNCIL_PHOTOGRAPHS'],
    isMitigation: false,
  },
  MITIGATION: {
    id: `${GENERAL_PREFIX}#mitigation`,
    prompt:
      'Was there something exceptional about that day, such as a medical emergency or a vehicle breakdown?',
    source: 'GENERAL_GUIDANCE',
    referenceKeys: ['GUIDANCE-DISCRETION'],
    relatedEvidence: ['BREAKDOWN_EVIDENCE', 'OTHER'],
    isMitigation: true,
  },
} as const satisfies Record<string, ContextQuestion>;

/** The procedure record covering a stage, found by the stage it declares. */
function procedureKeyForStage(stage: ProceduralStage): string | null {
  const record = referencesByCategory('PROCEDURE').find((r) => r.proceduralStage === stage);
  return record ? record.key : null;
}

export function selectContextQuestions(input: QuestionSelectionInput): ContextQuestionSet {
  const answered = new Set(input.answeredQuestionIds ?? []);
  const questions: ContextQuestion[] = [];

  /**
   * Adds a question only if every record it cites exists. This is the reason a
   * fabricated question cannot be displayed: there is no path to the user that
   * does not pass through here.
   */
  const emit = (question: ContextQuestion) => {
    if (answered.has(question.id)) return;
    if (question.referenceKeys.length === 0) return;
    if (!question.referenceKeys.every((key) => getReference(key) !== undefined)) return;
    questions.push(question);
  };

  /* ---- Contravention-specific, straight from the approved record ---------- */

  const record = input.contraventionCode ? getContravention(input.contraventionCode) : undefined;

  if (record) {
    const content = record.content as {
      commonFactualQuestions?: readonly string[];
      relevantEvidence?: readonly string[];
    };
    const relatedEvidence = (content.relevantEvidence ?? []).filter(isEvidenceType);

    (content.commonFactualQuestions ?? []).forEach((prompt, index) => {
      emit({
        // Keyed on the record, so an id cannot survive a change to the list it
        // came from and silently attach an answer to a different question.
        id: `${record.key}#${index}`,
        prompt,
        source: 'CONTRAVENTION_REFERENCE',
        referenceKeys: [record.key],
        relatedEvidence,
        isMitigation: false,
      });
    });
  }

  /* ---- General, and code-independent -------------------------------------- */

  // Every civil enforcement case has authority photographs, whatever the code,
  // and the procedure record for the stage lists gathering evidence as an
  // option — so this one is cited against the stage the case is actually at.
  const procedureKey = procedureKeyForStage(input.proceduralStage);
  if (procedureKey) {
    emit({ ...GENERAL_QUESTIONS.COUNCIL_PHOTOGRAPHS, referenceKeys: [procedureKey] });
  }

  // Mitigation is asked last and marked, because it is a different kind of
  // answer: it asks an authority to exercise discretion and does not say the
  // contravention did not happen.
  emit(GENERAL_QUESTIONS.MITIGATION);

  /* ---- Evidence the user may hold ----------------------------------------- */

  const provided = input.evidenceProvided ?? {};
  const alreadyDeclared = new Set(input.declaredEvidenceTypes ?? []);

  const evidenceQuestions: EvidenceQuestion[] = buildEvidenceRequirements({
    contraventionCode: input.contraventionCode,
    provided,
  })
    // Nothing is gained by asking whether they hold what they have given us,
    // and the notice image is the thing they just uploaded.
    .filter((req) => (provided[req.type] ?? 0) === 0)
    .filter((req) => req.type !== 'PCN_IMAGE')
    .filter((req) => !alreadyDeclared.has(req.type))
    .map((req) => ({
      type: req.type,
      label: EVIDENCE_DEFINITIONS[req.type].label,
      reason: req.reason,
      referenceKeys: req.referenceKeys,
      essential: req.importance === 'ESSENTIAL',
    }))
    .slice(0, MAX_EVIDENCE_QUESTIONS);

  return {
    questions: questions.slice(0, MAX_FACTUAL_QUESTIONS),
    evidenceQuestions,
    unknownContraventionCode:
      input.contraventionCode && !record ? input.contraventionCode : null,
  };
}

function isEvidenceType(value: string): value is EvidenceType {
  return value in EVIDENCE_DEFINITIONS;
}

/** The prompt for a question id, for rendering an answer back to the user. */
export function findQuestion(
  set: ContextQuestionSet,
  questionId: string,
): ContextQuestion | undefined {
  return set.questions.find((q) => q.id === questionId);
}

/**
 * The wording of a question, resolved from its id.
 *
 * The prompt is looked up rather than accepted from the caller. An answer
 * arrives over the wire as an id and a value, so if the text came with it the
 * client would be choosing the words that appear inside a PCNWatch finding.
 * Resolving here means every question shown back to a user is the reference
 * store's wording, whatever the request contained.
 *
 * Returns null for an id we cannot account for, and callers drop those answers.
 */
export function resolveQuestionPrompt(questionId: string): string | null {
  const [prefix, rest] = splitQuestionId(questionId);
  if (prefix === null || rest === null) return null;

  if (prefix === GENERAL_PREFIX) {
    return (
      Object.values(GENERAL_QUESTIONS).find((q) => q.id === questionId)?.prompt ?? null
    );
  }

  const record = getReference(prefix);
  if (!record) return null;
  const index = Number(rest);
  if (!Number.isInteger(index) || index < 0) return null;
  const prompts = (record.content as { commonFactualQuestions?: readonly string[] })
    .commonFactualQuestions;
  return prompts?.[index] ?? null;
}

/** True when a YES to this question is mitigation rather than a challenge to the facts. */
export function isMitigationQuestion(questionId: string): boolean {
  return Object.values(GENERAL_QUESTIONS).some((q) => q.id === questionId && q.isMitigation);
}

function splitQuestionId(id: string): [string | null, string | null] {
  const at = id.indexOf('#');
  if (at <= 0 || at === id.length - 1) return [null, null];
  return [id.slice(0, at), id.slice(at + 1)];
}

