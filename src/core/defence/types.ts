import type { EvidenceType } from '../evidence/types';
import type { SafeDeadline, RefusedDeadline } from '../deadlines/projection';
import type { EvidenceBasis } from '../assessment/types';
import type { ReferenceCitation } from '../reference/types';

/**
 * Where a statement in the Defence Pack came from.
 *
 * Every material assertion carries one of these, and the list is closed. A
 * sentence a model wrote is not on it: model output is a way of *saying* a
 * fact that one of these sources established, never a source in its own right.
 * That is the whole difference between this and an AI-generated appeal letter.
 */
export const PROVENANCE_SOURCES = [
  'VERIFIED_NOTICE_FACT',
  'CONFIRMED_USER_ASSERTION',
  'VERIFIED_EVIDENCE_FACT',
  'APPROVED_REFERENCE',
  'REVIEWED_RULE',
] as const;

export type ProvenanceSource = (typeof PROVENANCE_SOURCES)[number];

/** How each source is described to the user, so the Pack can show its working. */
export const PROVENANCE_LABELS: Record<ProvenanceSource, string> = {
  VERIFIED_NOTICE_FACT: 'Confirmed by you from the notice',
  CONFIRMED_USER_ASSERTION: 'Your account, confirmed by you',
  VERIFIED_EVIDENCE_FACT: 'Read from your evidence and confirmed by you',
  APPROVED_REFERENCE: 'Reviewed reference material',
  REVIEWED_RULE: 'Reviewed timing rule',
};

/**
 * One statement, and what stands behind it.
 *
 * `reference` is the internal handle the drafting layer must quote to use this
 * statement: a case field name, an assertion kind, an evidence id, or a
 * reference key. The validator checks a draft's assertions against these, so a
 * sentence citing something not on this list fails rather than being printed.
 */
export interface GroundedStatement {
  readonly text: string;
  readonly source: ProvenanceSource;
  readonly reference: string;
}

/** A. What the notice says, from confirmed fields only. */
export interface CaseSummarySection {
  readonly authority: string | null;
  readonly authorityRecognised: boolean;
  /** Shown masked. The full number is never rendered into the Pack. */
  readonly pcnNumberMasked: string | null;
  readonly vehicleRegistration: string | null;
  readonly contraventionCode: string | null;
  readonly contravention: string | null;
  readonly location: string | null;
  readonly incidentDate: string | null;
  readonly incidentTime: string | null;
  readonly stageLabel: string;
  readonly amount: string | null;
  /** Fields the user never confirmed, named rather than silently blank. */
  readonly unconfirmed: readonly string[];
}

/** B. What the user says happened, kept as testimony. */
export interface AccountSection {
  readonly provided: boolean;
  /** Each one attributed. Never restated as a PCNWatch finding. */
  readonly userSays: readonly GroundedStatement[];
  readonly openQuestions: readonly string[];
}

export type EvidenceStanding = 'CORROBORATIVE' | 'CONFLICTING' | 'NEUTRAL' | 'INCONCLUSIVE';

export interface EvidenceSummaryItem {
  readonly evidenceId: string;
  readonly type: EvidenceType;
  readonly label: string;
  readonly verifiedFacts: readonly GroundedStatement[];
  readonly supports: readonly string[];
  readonly contradicts: readonly string[];
  readonly standing: EvidenceStanding;
  readonly standingReason: string;
}

/** C. Evidence actually held, read and confirmed. Nothing declared. */
export interface EvidenceSection {
  readonly items: readonly EvidenceSummaryItem[];
  /** Claimed but never uploaded. Listed as a gap, never as evidence. */
  readonly declaredButNotHeld: readonly string[];
}

/** D. The factual points the record actually supports. */
export interface FactualPoint {
  readonly id: string;
  readonly headline: string;
  readonly detail: string;
  readonly grounds: readonly GroundedStatement[];
  readonly citations: readonly ReferenceCitation[];
}

/** E. Mandatory. What could weaken the challenge. */
export interface Weakness {
  readonly id: string;
  readonly what: string;
  readonly whyItMatters: string;
}

export type ChecklistStanding = 'ALREADY_HAVE' | 'RECOMMENDED' | 'NOT_RELEVANT';

export interface ChecklistEntry {
  readonly type: EvidenceType;
  readonly label: string;
  readonly standing: ChecklistStanding;
  readonly note: string;
}

/** G. Through the same boundary as everything else. */
export interface DatesSection {
  readonly deadlines: readonly SafeDeadline[];
  readonly refused: readonly RefusedDeadline[];
}

/**
 * What the Pack is not able to say.
 *
 * Every statutory ground in the reference store is PENDING_LEGAL_REVIEW, and so
 * is every contravention and procedure record. So the Pack states facts and
 * says, in as many words, that it is not asserting a legal ground — rather
 * than filling the gap from a model's memory of the Traffic Management Act.
 */
export interface LegalPositionSection {
  readonly canStateGrounds: boolean;
  readonly explanation: string;
  /** Grounds the user asked about that we hold no reviewed wording for. */
  readonly unreviewedGrounds: readonly string[];
}

export interface DefencePack {
  readonly caseSummary: CaseSummarySection;
  readonly account: AccountSection;
  readonly evidence: EvidenceSection;
  readonly factualPoints: readonly FactualPoint[];
  readonly weaknesses: readonly Weakness[];
  readonly checklist: readonly ChecklistEntry[];
  readonly dates: DatesSection;
  readonly legalPosition: LegalPositionSection;
  /** Carried through unchanged. Evidential support, never a chance of winning. */
  readonly evidenceBasis: EvidenceBasis;
  readonly evidenceBasisExplanation: string;
  /** Every handle the drafting layer is permitted to cite. */
  readonly permittedReferences: PermittedReferences;
}

/**
 * The closed set of things a challenge draft may assert.
 *
 * Built deterministically before a model is called, and checked after it
 * answers. A draft citing anything outside this is rejected whole — there is no
 * path by which a sentence becomes its own evidence.
 */
export interface PermittedReferences {
  readonly verifiedCaseFields: readonly string[];
  readonly confirmedAssertions: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly referenceKeys: readonly string[];
}
