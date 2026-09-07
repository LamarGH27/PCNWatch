export const EVIDENCE_TYPES = [
  'PCN_IMAGE',
  'COUNCIL_PHOTOGRAPHS',
  'PARKING_SIGN',
  'ROAD_MARKINGS',
  'VEHICLE_POSITION',
  'PAYMENT_RECEIPT',
  'PARKING_APP_RECEIPT',
  'PERMIT',
  'BLUE_BADGE',
  'LOADING_EVIDENCE',
  'WITNESS_INFORMATION',
  'BREAKDOWN_EVIDENCE',
  'CORRESPONDENCE',
  'OTHER',
] as const;

export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

export type EvidenceImportance = 'ESSENTIAL' | 'STRONG' | 'SUPPORTING';

export interface EvidenceDefinition {
  readonly type: EvidenceType;
  readonly label: string;
  /** What the user should actually capture — written for someone standing in the street. */
  readonly howToCapture: string;
  readonly whyItMatters: string;
}

export interface EvidenceRequirement {
  readonly type: EvidenceType;
  readonly importance: EvidenceImportance;
  /** Why this specific case needs it, referencing the contravention or ground. */
  readonly reason: string;
  /** Reference keys that justify asking for it. */
  readonly referenceKeys: readonly string[];
}

export interface EvidenceChecklistItem extends EvidenceRequirement {
  readonly definition: EvidenceDefinition;
  /**
   * Whether this requirement is actually met.
   *
   * Met means evidence that supports the case: held, read, and confirmed by the
   * user. Not "a file exists". The two were the same number for as long as
   * uploading was impossible, and keeping them the same afterwards is precisely
   * how an unread upload would start closing a gap it has not closed.
   */
  readonly provided: boolean;
  /** How many items of this type support the case. */
  readonly itemCount: number;
  /** How many files we hold of this type, whatever stage they have reached. */
  readonly heldCount: number;
}

export interface EvidenceChecklist {
  readonly items: readonly EvidenceChecklistItem[];
  readonly missingEssential: readonly EvidenceType[];
  readonly missingStrong: readonly EvidenceType[];
  readonly providedCount: number;
  /** Requirements where a file is held but has not yet been confirmed. */
  readonly awaitingCheckCount: number;
}
