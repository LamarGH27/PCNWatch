export type ReferenceCategory =
  | 'CONTRAVENTION'
  | 'PROCEDURE'
  | 'STATUTORY_GROUND'
  | 'GUIDANCE'
  | 'AUTHORITY_INFORMATION'
  | 'TRIBUNAL_INFORMATION';

export type ReferenceReviewStatus = 'REVIEWED' | 'PENDING_LEGAL_REVIEW';

export type Jurisdiction = 'ENGLAND_LONDON' | 'ENGLAND' | 'UK';

export type NoticeType =
  | 'PCN_ON_STREET'
  | 'PCN_POSTAL'
  | 'NOTICE_TO_OWNER'
  | 'NOTICE_OF_REJECTION'
  | 'NOTICE_OF_ACCEPTANCE'
  | 'CHARGE_CERTIFICATE'
  | 'ORDER_FOR_RECOVERY'
  | 'PRIVATE_PARKING_CHARGE'
  | 'UNKNOWN';

export type ProceduralStage =
  | 'NEW'
  | 'INFORMAL_CHALLENGE'
  | 'NOTICE_TO_OWNER'
  | 'FORMAL_REPRESENTATION'
  | 'NOTICE_OF_ACCEPTANCE'
  | 'NOTICE_OF_REJECTION'
  | 'TRIBUNAL_ELIGIBLE'
  | 'TRIBUNAL_APPEAL'
  | 'CLOSED_WON'
  | 'CLOSED_PAID'
  | 'CLOSED_LOST'
  | 'UNKNOWN_STAGE';

/**
 * A single approved reference record.
 *
 * The generative layer may only cite records that exist here. `sourceName` and
 * `sourceLocation` must point at something a human reviewer can independently open;
 * a record without them is invalid and rejected at load time.
 */
export interface ReferenceRecord {
  readonly key: string;
  readonly version: number;
  readonly category: ReferenceCategory;
  readonly title: string;
  readonly jurisdiction: Jurisdiction;
  /** Authority slug when the record is authority-specific, otherwise null. */
  readonly authorityId: string | null;
  readonly noticeType: NoticeType | null;
  readonly proceduralStage: ProceduralStage | null;
  readonly sourceName: string;
  readonly sourceLocation: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly reviewedAt: string | null;
  readonly reviewStatus: ReferenceReviewStatus;
  /** Plain-language summary safe to show a user. */
  readonly summary: string;
  /** Structured payload; shape depends on `category`. */
  readonly content: Readonly<Record<string, unknown>>;
}

export interface ReferenceCitation {
  readonly key: string;
  readonly version: number;
  readonly title: string;
  readonly sourceName: string;
  readonly sourceLocation: string;
  readonly reviewStatus: ReferenceReviewStatus;
}
