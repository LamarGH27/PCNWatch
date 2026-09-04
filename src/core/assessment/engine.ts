import { buildEvidenceChecklist } from '../evidence/checklist';
import type { EvidenceType } from '../evidence/types';
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
    return {
      basis: 'INSUFFICIENT_INFORMATION',
      explanation:
        'You have not yet identified a ground to rely on, so there is nothing for us to assess the evidence against.',
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

export function formatPence(pence: number): string {
  return `£${(pence / 100).toFixed(2)}`;
}

/** Every reference key the drafting layer is permitted to cite for this assessment. */
export function permittedCitationKeys(assessment: Assessment): string[] {
  return Array.from(new Set(assessment.citations.map((c) => c.key)));
}

export { citationsFor };
