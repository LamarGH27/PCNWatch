import type { EvidenceImportance, EvidenceType } from '../evidence/types';
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
  /**
   * The notice the case was built from.
   *
   * True when the user photographed their PCN and confirmed what we read off
   * it. Kept separate from `items` because it is not an evidence upload and
   * never became one — but it means the Pack has seen the notice, and must not
   * ask for it again.
   */
  readonly sourceNoticeHeld: boolean;
}

/**
 * What a point rests on.
 *
 * The ordering is the product's honesty: a document the user confirmed
 * outranks the same claim resting on their word, and the Pack says which it is
 * rather than letting the reader assume. `VERIFIED_EVIDENCE_FACT` is stronger
 * than `CONFIRMED_USER_ASSERTION` and always will be — what changed is that an
 * account with no evidence behind it is now shown, labelled, instead of
 * withheld.
 *
 * Withholding it was the worse failure. A pack that told a user with a real
 * case theory "there is nothing here the record supports yet" had the theory,
 * knew it was uncorroborated, and said nothing at all.
 */
export type PointBasis = 'VERIFIED_EVIDENCE' | 'USER_ACCOUNT';

export const POINT_BASIS_LABELS: Record<PointBasis, string> = {
  VERIFIED_EVIDENCE: 'From a document you provided and checked',
  USER_ACCOUNT: 'Your account — not yet corroborated by uploaded evidence',
};

/** D. The factual points the record actually supports. */
export interface FactualPoint {
  readonly id: string;
  readonly headline: string;
  readonly detail: string;
  readonly basis: PointBasis;
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
  /** From the reference store, via the evidence checklist. Drives the ranking. */
  readonly importance: EvidenceImportance;
}

/**
 * The checklist, in the order somebody would actually work through it.
 *
 * A flat list of six things to gather reads as a tribunal bundle, and the
 * effect on a person deciding whether to challenge at all is to make it look
 * like more work than it is. `mostUseful` is capped at three and ranked by the
 * existing evidence engine; everything else stays available behind a
 * disclosure rather than being dropped.
 */
export interface EvidenceChecklistSections {
  readonly alreadyHave: readonly ChecklistEntry[];
  readonly mostUseful: readonly ChecklistEntry[];
  readonly other: readonly ChecklistEntry[];
  readonly notRelevant: readonly ChecklistEntry[];
}

export const MAX_MOST_USEFUL = 3;

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

/**
 * Whether the Pack is a finished deliverable.
 *
 * The letter used to be able to fail while the rest of the Pack saved and
 * displayed as though nothing had happened — a £5.99 product presenting itself
 * as complete with its headline item missing. These three states exist so that
 * cannot happen quietly, and so a future payment step has something to check
 * before it takes money for something that did not generate.
 */
export const PACK_STATUSES = ['PACK_READY', 'PACK_PARTIAL', 'PACK_GENERATION_FAILED'] as const;

export type PackStatus = (typeof PACK_STATUSES)[number];

export const PACK_STATUS_LABELS: Record<PackStatus, string> = {
  PACK_READY: 'Your Defence Pack is ready',
  PACK_PARTIAL: 'Your Defence Pack is ready, without the letter',
  PACK_GENERATION_FAILED: 'We could not build your Defence Pack',
};

/** Only a Pack whose letter was produced and accepted is a finished product. */
export function packStatusFor(input: {
  readonly packBuilt: boolean;
  readonly letterDrafted: boolean;
}): PackStatus {
  if (!input.packBuilt) return 'PACK_GENERATION_FAILED';
  return input.letterDrafted ? 'PACK_READY' : 'PACK_PARTIAL';
}

export interface DefencePack {
  readonly caseSummary: CaseSummarySection;
  readonly account: AccountSection;
  readonly evidence: EvidenceSection;
  readonly factualPoints: readonly FactualPoint[];
  readonly weaknesses: readonly Weakness[];
  readonly checklist: readonly ChecklistEntry[];
  /** The same entries, split for a reader rather than for a completeness check. */
  readonly checklistSections: EvidenceChecklistSections;
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
