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
  readonly provided: boolean;
  readonly itemCount: number;
}

export interface EvidenceChecklist {
  readonly items: readonly EvidenceChecklistItem[];
  readonly missingEssential: readonly EvidenceType[];
  readonly missingStrong: readonly EvidenceType[];
  readonly providedCount: number;
}
