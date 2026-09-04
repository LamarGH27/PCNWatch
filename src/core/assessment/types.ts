import type { ReferenceCitation } from '../reference/types';
import type { EvidenceType } from '../evidence/types';

export type EvidenceBasis =
  | 'STRONG_EVIDENCE_BASIS'
  | 'MODERATE_EVIDENCE_BASIS'
  | 'WEAK_EVIDENCE_BASIS'
  | 'INSUFFICIENT_INFORMATION';

export const EVIDENCE_BASIS_LABELS: Record<EvidenceBasis, string> = {
  STRONG_EVIDENCE_BASIS: 'Strong evidence basis',
  MODERATE_EVIDENCE_BASIS: 'Moderate evidence basis',
  WEAK_EVIDENCE_BASIS: 'Weak evidence basis',
  INSUFFICIENT_INFORMATION: 'Insufficient information',
};

export type FindingCategory =
  | 'STATUTORY_GROUND'
  | 'FACTUAL_DISPUTE'
  | 'PROCEDURAL_ISSUE'
  | 'DISCRETIONARY';

export type FindingConfidence = 'HIGH' | 'MEDIUM' | 'LOW';

export interface AssessmentFinding {
  readonly id: string;
  readonly category: FindingCategory;
  /** The issue, stated neutrally. */
  readonly issue: string;
  /** Why it may matter — never asserted as a conclusion. */
  readonly whyItMayMatter: string;
  readonly evidenceNeeded: readonly EvidenceType[];
  readonly evidenceAvailable: readonly EvidenceType[];
  readonly citations: readonly ReferenceCitation[];
  readonly confidence: FindingConfidence;
  /** Ground reference key when the finding maps onto a statutory ground. */
  readonly groundKey: string | null;
}

export interface Assessment {
  readonly basis: EvidenceBasis;
  readonly basisExplanation: string;
  readonly findings: readonly AssessmentFinding[];
  readonly findingsByCategory: Readonly<Record<FindingCategory, readonly AssessmentFinding[]>>;
  readonly missingInformation: readonly string[];
  readonly citations: readonly ReferenceCitation[];
  /** True when the case is outside what this version supports. */
  readonly outOfScope: boolean;
  readonly outOfScopeMessage: string | null;
  readonly generatedFrom: {
    readonly contraventionCode: string | null;
    readonly proceduralStage: string;
    readonly engineVersion: string;
  };
}
