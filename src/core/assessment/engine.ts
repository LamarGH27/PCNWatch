import { buildEvidenceChecklist } from '../evidence/checklist';
import type { EvidenceType } from '../evidence/types';
import { EVIDENCE_DEFINITIONS } from '../evidence/definitions';
import type { AnswerValue, UserContext } from '../context/types';
import {
  evidenceForAssertion,
  isMitigationAssertion,
  isMitigationQuestion,
  resolveQuestionPrompt,
} from '../context/questions';
import { reconcileContext } from '../context/reconcile';
import { ASSERTION_LABELS } from '../context/types';
import { PRIVATE_PARKING_MESSAGE } from '../notices/classify-notice';
import { citationsFor, getContravention, getReference, toCitation } from '../reference/store';
import type { ProceduralStage, ReferenceCitation } from '../reference/types';
import type {
  Assessment,
  AssessmentFinding,
  EvidenceBasis,
  FindingCategory,
} from './types';

export const ASSESSMENT_ENGINE_VERSION = 'assess-1.0.0';

export interface AssessmentInput {
  readonly contraventionCode: string | null;
  readonly contraventionSuffix?: string | null;
  readonly proceduralStage: ProceduralStage;
  readonly noticeCategory: 'LOCAL_AUTHORITY_PCN' | 'PRIVATE_PARKING_CHARGE' | 'UNKNOWN';
  /** Ground keys the user has said they want to rely on. */
  readonly assertedGroundKeys: readonly string[];
  /** Evidence the user has actually uploaded. */
  readonly evidenceProvided: Partial<Record<EvidenceType, number>>;
  /** The user's own account, used only to decide which questions remain open. */
  readonly userNarrativeProvided: boolean;
  /**
   * The user's answers and what they say they can produce.
   *
   * Deliberately separate from `evidenceProvided`. That field means evidence we
   * actually hold; this one means evidence the user tells us exists. A claim to
   * hold a permit is not a permit, and the two must never be added together —
   * see `determineBasis`, which will not let a declaration reach a basis that
   * held evidence has to earn.
   */
  readonly userContext?: UserContext;
  /** Fields the user has verified from the notice. */
  readonly verifiedFields: {
    readonly pcnNumber: boolean;
    readonly contraventionCode: boolean;
    readonly incidentDate: boolean;
    readonly location: boolean;
    readonly amount: boolean;
  };
  /** Amount demanded vs. band, when both are known — drives the PENALTY_EXCEEDED check. */
  readonly amountCheck?: {
    readonly amountDemandedPence: number;
    readonly expectedFullPence: number | null;
    readonly expectedDiscountedPence: number | null;
  };
}

/**
 * Produces a deterministic assessment.
 *
 * Everything here is rules-driven. No model is involved: a model may later
 * *explain* these findings more fluently, but it may not add, remove or upgrade one.
 * Where information is missing the engine says so rather than filling the gap.
 */
export function assessCase(input: AssessmentInput): Assessment {
  if (input.noticeCategory === 'PRIVATE_PARKING_CHARGE') {
    return outOfScopeAssessment(input, PRIVATE_PARKING_MESSAGE);
  }
  if (input.noticeCategory === 'UNKNOWN') {
    return outOfScopeAssessment(
      input,
      'We could not confirm whether this is a local-authority PCN. Confirm the notice type before we assess it.',
    );
  }

  const findings: AssessmentFinding[] = [];
  const missingInformation: string[] = [];
  const checklist = buildEvidenceChecklist({
    contraventionCode: input.contraventionCode,
    assertedGroundKeys: input.assertedGroundKeys,
    provided: input.evidenceProvided,
  });

  const has = (type: EvidenceType) => (input.evidenceProvided[type] ?? 0) > 0;
  const availableFrom = (types: readonly EvidenceType[]) => types.filter(has);

  /* ---- Verification gaps -------------------------------------------------- */

  if (!input.verifiedFields.contraventionCode) {
    missingInformation.push('The contravention code has not been confirmed against your notice.');
  }
  if (!input.verifiedFields.incidentDate) {
    missingInformation.push('The date of the alleged contravention has not been confirmed.');
  }
  if (!input.verifiedFields.location) {
    missingInformation.push('The location on the notice has not been confirmed.');
  }
  if (!input.userNarrativeProvided) {
    missingInformation.push('You have not yet told us what actually happened, in your own words.');
  }

  /* ---- Contravention-specific factual questions ---------------------------- */

  const contravention = input.contraventionCode ? getContravention(input.contraventionCode) : undefined;

  if (input.contraventionCode && !contravention) {
    missingInformation.push(
      `We do not hold a reviewed reference record for contravention code ${input.contraventionCode}, so we cannot assess it in detail.`,
    );
  }

  if (contravention) {
    const content = contravention.content as {
      commonFactualQuestions?: readonly string[];
      relevantEvidence?: readonly EvidenceType[];
      officialDescription?: string;
    };
    const needed = (content.relevantEvidence ?? []) as readonly EvidenceType[];
    findings.push({
      id: `factual-${contravention.key}`,
      category: 'FACTUAL_DISPUTE',
      issue: `What the authority alleges under code ${input.contraventionCode}: ${content.officialDescription ?? contravention.title}`,
      whyItMayMatter:
        'A challenge succeeds or fails on whether the alleged facts happened. These are the questions this contravention normally turns on: ' +
        (content.commonFactualQuestions ?? []).join(' '),
      evidenceNeeded: needed,
      evidenceAvailable: availableFrom(needed),
      citations: [toCitation(contravention)],
      confidence: contravention.reviewStatus === 'REVIEWED' ? 'HIGH' : 'MEDIUM',
      groundKey: null,
    });
  }

  if (input.contraventionSuffix) {
    missingInformation.push(
      `Your notice shows a suffix "${input.contraventionSuffix}" after the contravention code. That suffix identifies the specific restriction and we do not hold a reference record for it, so we have not interpreted it.`,
    );
  }

  /* ---- Asserted statutory grounds ------------------------------------------ */

  for (const groundKey of input.assertedGroundKeys) {
    const record = getReference(groundKey);
    if (!record) {
      missingInformation.push(`We do not hold a reference record for "${groundKey}", so it was not assessed.`);
      continue;
    }
    const content = record.content as {
      requiredFacts?: readonly string[];
      relevantEvidence?: readonly EvidenceType[];
      availableAtStages?: readonly string[];
    };
    const needed = (content.relevantEvidence ?? []) as readonly EvidenceType[];
    const available = availableFrom(needed);
    const stageOk =
      !content.availableAtStages || content.availableAtStages.includes(input.proceduralStage);

    findings.push({
      id: `ground-${record.key}`,
      category: 'STATUTORY_GROUND',
      issue: record.title,
      whyItMayMatter: stageOk
        ? `${record.summary} To rely on it you need to establish: ${(content.requiredFacts ?? []).join('; ')}.`
        : `${record.summary} This ground is not normally available at your current stage (${input.proceduralStage}).`,
      evidenceNeeded: needed,
      evidenceAvailable: available,
      citations: [toCitation(record)],
      confidence: available.length === 0 ? 'LOW' : available.length >= needed.length / 2 ? 'HIGH' : 'MEDIUM',
      groundKey: record.key,
    });
  }

  /* ---- What the user told us ----------------------------------------------- */

  /*
   * One canonical set of facts, from both the questions and the account.
   *
   * These used to be two findings built in two blocks that never saw each
   * other, and a real assessment printed "Did you buy a pay-and-display ticket
   * or pay by app instead? — no." above "you paid to park; you paid using an
   * app". Both were faithful records of something the user had said; showing
   * them together as though they agreed was the failure, and it left PCNWatch
   * with no idea which fact it was reasoning about either.
   *
   * `reconcileContext` reduces both sources to one fact per topic. Where they
   * genuinely disagree it produces a conflict instead of a fact, and a
   * conflicted topic contributes nothing here — the assessment does not get to
   * pick a side quietly, and the caller is expected to have put the choice to
   * the user before asking for an assessment at all.
   */
  const context = input.userContext;
  const reconciled = reconcileContext(
    context?.answers ?? [],
    context?.confirmedAssertions ?? [],
    context?.resolvedFacts ?? [],
  );

  const asserted = reconciled.facts.filter(
    (fact) => fact.stance === 'ASSERTED' && !isMitigationAssertion(fact.topic),
  );

  /*
   * Answers to questions with no topic mapping.
   *
   * They cannot be reconciled, so they cannot be checked for contradiction
   * either. They are folded into the same finding rather than given one of
   * their own: a second "what you told us" block is how the original
   * contradiction came to be displayed as two confident statements.
   *
   * The wording still comes from the reference store, resolved from the id.
   */
  const unmapped = reconciled.unmappedAnswers
    .filter((answer) => answer.answer !== 'UNANSWERED')
    .map((answer) => ({ ...answer, prompt: resolveQuestionPrompt(answer.questionId) }))
    .filter((answer): answer is typeof answer & { prompt: string } => answer.prompt !== null)
    .filter((answer) => !isMitigationQuestion(answer.questionId));

  if (asserted.length > 0 || unmapped.length > 0) {
    const evidence = dedupeEvidence([
      ...asserted.flatMap((fact) => evidenceForAssertion(fact.topic)),
      ...unmapped.flatMap((answer) => evidenceForQuestion(answer.questionId, input.contraventionCode)),
    ]);

    const parts: string[] = [];
    if (asserted.length > 0) {
      parts.push(`${asserted.map((f) => lowerFirst(ASSERTION_LABELS[f.topic])).join('; ')}.`);
    }
    for (const answer of unmapped) {
      parts.push(`${answer.prompt} — ${ANSWER_WORDS[answer.answer]}`);
    }

    findings.push({
      id: 'context-user-facts',
      category: 'FACTUAL_DISPUTE',
      issue: 'What you have told us about what happened',
      whyItMayMatter:
        `You told us: ${parts.join(' ')} ` +
        'This is your account rather than a finding of ours, and an authority will want it ' +
        'corroborated. What would support it is listed here.',
      evidenceNeeded: evidence,
      evidenceAvailable: availableFrom(evidence),
      // Cited against the contravention record the questions came from, when
      // there is one and a question contributed. Nothing here asserts law.
      citations: contravention && unmapped.length > 0 ? [toCitation(contravention)] : [],
      // Low by construction: an account rests on the user's say-so until
      // something corroborates it, and this finding never sees held evidence.
      confidence: 'LOW',
      groundKey: null,
    });
  }

  // Something the user plainly meant that the closed schema could not hold. It
  // is surfaced for a person to read rather than approximated into a fact.
  if (reconciled.facts.some((fact) => fact.topic === 'OTHER_REQUIRES_REVIEW')) {
    missingInformation.push(
      'You told us something we could not fit into the checks we run automatically. It has not been ignored, but it has also not been assessed — nothing in this page takes it into account.',
    );
  }

  /*
   * A disagreement we could not resolve.
   *
   * Reaching this point means an assessment was produced from a context that
   * still contains one, which the endpoint refuses to do. The fact is excluded
   * either way, and saying so is better than a page that quietly knows less
   * than it appears to.
   */
  for (const conflict of reconciled.conflicts) {
    missingInformation.push(
      `You have given us two different answers about ${lowerFirst(ASSERTION_LABELS[conflict.topic])}. Until you tell us which is right we have left it out of this assessment entirely.`,
    );
  }

  // Not knowing cuts the same way whatever the source, so this is the one
  // answer the engine can act on without a judgement about polarity.
  for (const fact of reconciled.facts) {
    if (fact.stance === 'UNCLEAR') {
      missingInformation.push(
        `Your account left this open: ${lowerFirst(ASSERTION_LABELS[fact.topic])}. Pinning it down would let us say more.`,
      );
    }
  }
  for (const answer of unmapped) {
    if (answer.answer === 'NOT_SURE') {
      missingInformation.push(
        `You were not sure: ${answer.prompt} Finding out would let us say more.`,
      );
    }
  }

  /*
   * Mitigation is a separate category on purpose.
   *
   * An authority may cancel a penalty at its discretion even where the
   * contravention did occur, and an adjudicator's powers are narrower than
   * that. Presenting "there was a medical emergency" beside a statutory ground
   * would tell the user the two carry the same weight. They do not.
   */
  const mitigation = reconciled.facts.some(
    (fact) => isMitigationAssertion(fact.topic) && fact.stance === 'ASSERTED',
  );
  const discretionRecord = getReference('GUIDANCE-DISCRETION');
  if (mitigation && discretionRecord) {
    const caution = (discretionRecord.content as { caution?: string }).caution;
    findings.push({
      id: 'context-mitigation',
      category: 'DISCRETIONARY',
      issue: 'You have told us there were exceptional circumstances',
      whyItMayMatter:
        `${discretionRecord.summary} ${caution ?? ''} `.trim() +
        ' Evidence of the circumstances themselves is what makes this worth raising.',
      evidenceNeeded: ['BREAKDOWN_EVIDENCE', 'CORRESPONDENCE', 'OTHER'],
      evidenceAvailable: availableFrom(['BREAKDOWN_EVIDENCE', 'CORRESPONDENCE', 'OTHER']),
      citations: [toCitation(discretionRecord)],
      confidence: 'LOW',
      groundKey: null,
    });
  }

  /*
   * Evidence the user says they hold but has not given us.
   *
   * This is missing information, not evidence. It is the single most likely
   * place for a product like this to flatter a user: they say they have the
   * permit, the basis rises, and they submit a challenge resting on a document
   * nobody has looked at. So a declaration lands here and nowhere else, and
   * `determineBasis` is told about it separately precisely so it can refuse to
   * count it.
   */
  for (const declared of context?.declaredEvidence ?? []) {
    const definition = EVIDENCE_DEFINITIONS[declared.type];
    if (!definition) continue;
    if (declared.held === 'HAVE' && (input.evidenceProvided[declared.type] ?? 0) === 0) {
      missingInformation.push(
        `You said you can produce ${lowerFirst(definition.label)}. We have not seen it, so it is not yet supporting your case.`,
      );
    }
    if (declared.held === 'NOT_SURE') {
      missingInformation.push(
        `You were not sure whether you have ${lowerFirst(definition.label)}. ${definition.whyItMatters}`,
      );
    }
  }

  /* ---- Procedural checks --------------------------------------------------- */

  if (input.amountCheck) {
    const { amountDemandedPence, expectedFullPence, expectedDiscountedPence } = input.amountCheck;
    if (expectedFullPence === null) {
      missingInformation.push(
        'We do not hold the penalty band for this authority and contravention, so we have not checked the amount demanded.',
      );
    } else if (
      amountDemandedPence > expectedFullPence &&
      amountDemandedPence !== expectedDiscountedPence
    ) {
      const record = getReference('GROUND-PENALTY_EXCEEDED');
      findings.push({
        id: 'procedural-amount',
        category: 'PROCEDURAL_ISSUE',
        issue: 'The amount demanded appears higher than the band we hold for this contravention.',
        whyItMayMatter:
          `Your notice shows ${formatPence(amountDemandedPence)} where we hold ${formatPence(expectedFullPence)} as the full amount. ` +
          'Check the figure on your notice carefully before relying on this — an escalated amount after a Charge Certificate is a different thing.',
        evidenceNeeded: ['PCN_IMAGE'],
        evidenceAvailable: availableFrom(['PCN_IMAGE']),
        citations: record ? [toCitation(record)] : [],
        confidence: input.verifiedFields.amount ? 'MEDIUM' : 'LOW',
        groundKey: 'GROUND-PENALTY_EXCEEDED',
      });
    }
  }

  /* ---- Evidence gaps as findings ------------------------------------------- */

  if (checklist.missingEssential.length > 0) {
    findings.push({
      id: 'evidence-gap-essential',
      category: 'FACTUAL_DISPUTE',
      issue: 'Essential evidence is missing.',
      whyItMayMatter:
        'Without these items your account cannot be corroborated, which materially weakens anything you submit.',
      evidenceNeeded: checklist.missingEssential,
      evidenceAvailable: [],
      citations: [],
      confidence: 'HIGH',
      groundKey: null,
    });
  }

  const basisResult = determineBasis(input, findings, checklist.missingEssential.length);

  const citations = dedupeCitations(findings.flatMap((f) => f.citations));

  return {
    basis: basisResult.basis,
    basisExplanation: basisResult.explanation,
    findings,
    findingsByCategory: groupByCategory(findings),
    missingInformation,
    citations,
    outOfScope: false,
    outOfScopeMessage: null,
    generatedFrom: {
      contraventionCode: input.contraventionCode,
      proceduralStage: input.proceduralStage,
      engineVersion: ASSESSMENT_ENGINE_VERSION,
    },
  };
}

function determineBasis(
  input: AssessmentInput,
  findings: readonly AssessmentFinding[],
  missingEssentialCount: number,
): { basis: EvidenceBasis; explanation: string } {
  const coreVerified =
    input.verifiedFields.contraventionCode &&
    input.verifiedFields.incidentDate &&
    input.verifiedFields.location;

  if (!coreVerified || !input.userNarrativeProvided) {
    return {
      basis: 'INSUFFICIENT_INFORMATION',
      explanation:
        'We do not yet have enough confirmed information about your case to assess it. Confirm the key details from your notice and tell us what happened, and we will reassess.',
    };
  }

  const groundFindings = findings.filter((f) => f.category === 'STATUTORY_GROUND');
  if (groundFindings.length === 0) {
    /*
     * No ground has been chosen. In the free assessment nobody has chosen one
     * yet — choosing is a later, deliberate act — but the user has confirmed
     * their notice and told us what happened, so we can still describe how well
     * evidenced their account is against what this contravention normally turns
     * on. Saying nothing at that point is not caution, it is unhelpfulness.
     *
     * The ceiling is the point of this branch. Without a ground the evidence has
     * nothing specific to cover, so MODERATE is as far as it can go, and it gets
     * there only on evidence we actually hold.
     */
    const engaged =
      (input.userContext?.answers.length ?? 0) > 0 ||
      (input.userContext?.declaredEvidence.length ?? 0) > 0 ||
      (input.userContext?.confirmedAssertions.length ?? 0) > 0;

    if (!engaged) {
      return {
        basis: 'INSUFFICIENT_INFORMATION',
        explanation:
          'You have not yet identified a ground to rely on, so there is nothing for us to assess the evidence against.',
      };
    }

    /*
     * Held, not declared.
     *
     * `evidenceProvided` counts documents PCNWatch has. A declaration that one
     * exists is deliberately not consulted here: if it were, a user could reach
     * a moderate basis by ticking boxes about documents nobody has seen, and
     * they would submit a challenge believing it was evidenced when it was not.
     */
    const heldCount = Object.values(input.evidenceProvided).filter((n) => (n ?? 0) > 0).length;
    const claimed = (input.userContext?.declaredEvidence ?? []).filter((d) => d.held === 'HAVE');

    if (heldCount === 0) {
      return {
        basis: 'WEAK_EVIDENCE_BASIS',
        explanation:
          (claimed.length > 0
            ? `You have told us about ${claimed.length} item${claimed.length === 1 ? '' : 's'} of supporting evidence, but we have not seen ${claimed.length === 1 ? 'it' : 'them'}. `
            : 'You have not told us about any supporting evidence yet. ') +
          'As things stand your case would rest on your account alone. ' +
          'This describes how well your case is evidenced. It is not a prediction of the outcome.',
      };
    }
    return {
      basis:
        missingEssentialCount === 0 ? 'MODERATE_EVIDENCE_BASIS' : 'WEAK_EVIDENCE_BASIS',
      explanation:
        'You have supporting evidence and have told us what happened. Until you decide which ground you are relying on we cannot say how completely that evidence covers it. ' +
        'This describes how well your case is evidenced. It is not a prediction of the outcome.',
    };
  }

  const supported = groundFindings.filter((f) => f.confidence === 'HIGH');
  const partial = groundFindings.filter((f) => f.confidence === 'MEDIUM');

  if (supported.length > 0 && missingEssentialCount === 0) {
    return {
      basis: 'STRONG_EVIDENCE_BASIS',
      explanation:
        `You have evidence covering the main points for ${supported.length === 1 ? 'the ground' : 'the grounds'} you are relying on, and no essential item is missing. ` +
        'This describes how well your case is evidenced. It is not a prediction of the outcome.',
    };
  }
  if (supported.length > 0 || partial.length > 0) {
    return {
      basis: 'MODERATE_EVIDENCE_BASIS',
      explanation:
        'You have some evidence for the grounds you are relying on, but there are gaps. Closing them before you submit is the single most useful thing you can do. ' +
        'This describes how well your case is evidenced. It is not a prediction of the outcome.',
    };
  }
  return {
    basis: 'WEAK_EVIDENCE_BASIS',
    explanation:
      'You have identified grounds but have not yet provided evidence that supports them. As things stand your submission would rest on your account alone. ' +
      'This describes how well your case is evidenced. It is not a prediction of the outcome.',
  };
}

function outOfScopeAssessment(input: AssessmentInput, message: string): Assessment {
  const record = getReference('GUIDANCE-PRIVATE-PARKING-OUT-OF-SCOPE');
  return {
    basis: 'INSUFFICIENT_INFORMATION',
    basisExplanation: message,
    findings: [],
    findingsByCategory: groupByCategory([]),
    missingInformation: [message],
    citations: record && input.noticeCategory === 'PRIVATE_PARKING_CHARGE' ? [toCitation(record)] : [],
    outOfScope: true,
    outOfScopeMessage: message,
    generatedFrom: {
      contraventionCode: input.contraventionCode,
      proceduralStage: input.proceduralStage,
      engineVersion: ASSESSMENT_ENGINE_VERSION,
    },
  };
}

function groupByCategory(
  findings: readonly AssessmentFinding[],
): Record<FindingCategory, readonly AssessmentFinding[]> {
  return {
    STATUTORY_GROUND: findings.filter((f) => f.category === 'STATUTORY_GROUND'),
    FACTUAL_DISPUTE: findings.filter((f) => f.category === 'FACTUAL_DISPUTE'),
    PROCEDURAL_ISSUE: findings.filter((f) => f.category === 'PROCEDURAL_ISSUE'),
    DISCRETIONARY: findings.filter((f) => f.category === 'DISCRETIONARY'),
  };
}

function dedupeCitations(citations: readonly ReferenceCitation[]): ReferenceCitation[] {
  const seen = new Map<string, ReferenceCitation>();
  for (const c of citations) seen.set(`${c.key}@${c.version}`, c);
  return [...seen.values()];
}

const ANSWER_WORDS: Record<AnswerValue, string> = {
  YES: 'yes.',
  NO: 'no.',
  NOT_SURE: 'not sure.',
  // Never rendered: an unanswered question is filtered out long before this.
  // Present so the record is total and a new answer value cannot be forgotten.
  UNANSWERED: '',
};

/**
 * What a question implicates, resolved from the store rather than the request.
 * A general question falls back to the contravention's own evidence list.
 */
function evidenceForQuestion(
  questionId: string,
  contraventionCode: string | null,
): readonly EvidenceType[] {
  const [prefix] = questionId.split('#');
  const record = prefix === 'GENERAL'
    ? contraventionCode
      ? getContravention(contraventionCode)
      : undefined
    : getReference(prefix as string);
  if (!record) return [];
  const raw = (record.content as { relevantEvidence?: readonly string[] }).relevantEvidence ?? [];
  return raw.filter((v): v is EvidenceType => v in EVIDENCE_DEFINITIONS);
}

function dedupeEvidence(types: readonly EvidenceType[]): EvidenceType[] {
  return [...new Set(types)];
}

function lowerFirst(text: string): string {
  return text.length === 0 ? text : text[0]!.toLowerCase() + text.slice(1);
}

export function formatPence(pence: number): string {
  return `£${(pence / 100).toFixed(2)}`;
}

/** Every reference key the drafting layer is permitted to cite for this assessment. */
export function permittedCitationKeys(assessment: Assessment): string[] {
  return Array.from(new Set(assessment.citations.map((c) => c.key)));
}

export { citationsFor };
