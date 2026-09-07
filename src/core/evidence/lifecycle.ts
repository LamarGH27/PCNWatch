import type { EvidenceType } from './types';

/**
 * How far a piece of evidence has got, and what each stage entitles it to.
 *
 * The four states are deliberately not collapsible:
 *
 *   DECLARED  the user told us this exists. We have never seen it.
 *   UPLOADED  we hold the file. Nothing has read it.
 *   ANALYSED  a reading pass produced observations the user has not confirmed.
 *   VERIFIED  the user confirmed the readings.
 *
 * Only the last one supports anything. A product that let an upload count as
 * support would be telling someone their case is evidenced on the strength of a
 * file nobody has looked at — including us. And a product that let a model's
 * reading count would be resting a challenge on what a model thought it saw.
 *
 * So the promotion from ANALYSED to VERIFIED is a person's decision and cannot
 * be reached any other way. Confidence does not make it; legibility does not
 * make it; a retry does not make it.
 */

export const EVIDENCE_STATUSES = ['DECLARED', 'UPLOADED', 'ANALYSED', 'VERIFIED'] as const;

export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];

export const EVIDENCE_STATUS_LABELS: Record<EvidenceStatus, string> = {
  DECLARED: 'You told us about this',
  UPLOADED: 'Uploaded, not yet read',
  ANALYSED: 'Read — needs your check',
  VERIFIED: 'Checked by you',
};

/** Said plainly, in the user's terms, on the evidence page. */
export const EVIDENCE_STATUS_MEANING: Record<EvidenceStatus, string> = {
  DECLARED: 'We have not seen this, so it is not supporting your case.',
  UPLOADED: 'We hold this file but nothing has read it yet, so it is not supporting your case.',
  ANALYSED:
    'We have read what we can from this. Nothing from it counts until you check that we read it correctly.',
  VERIFIED: 'You have confirmed what we read. This is supporting your case.',
};

export const EVIDENCE_LEGIBILITY_LEVELS = ['CLEAR', 'PARTIAL', 'UNREADABLE'] as const;

export type EvidenceLegibility = (typeof EVIDENCE_LEGIBILITY_LEVELS)[number];

export function isEvidenceStatus(value: unknown): value is EvidenceStatus {
  return typeof value === 'string' && (EVIDENCE_STATUSES as readonly string[]).includes(value);
}

export function isEvidenceLegibility(value: unknown): value is EvidenceLegibility {
  return (
    typeof value === 'string' && (EVIDENCE_LEGIBILITY_LEVELS as readonly string[]).includes(value)
  );
}

/** One fact the user confirmed we read correctly. The only output of this pipeline. */
export interface VerifiedEvidenceFact {
  readonly field: string;
  readonly value: string;
}

/** An evidence item as the rest of the application sees it. */
export interface EvidenceItem {
  readonly id: string;
  readonly type: EvidenceType;
  readonly status: EvidenceStatus;
  readonly originalFilename: string | null;
  readonly contentType: string | null;
  readonly byteSize: number | null;
  readonly legibility: EvidenceLegibility | null;
  /** Populated from ANALYSED onwards. A proposal, never a fact. */
  readonly analysis: EvidenceAnalysisRecord | null;
  /** Populated at VERIFIED. The only part an assessment may read. */
  readonly verifiedFacts: readonly VerifiedEvidenceFact[];
  /** Set when the last reading pass failed. The file is still held. */
  readonly analysisFailure: string | null;
  readonly analysisAttempts: number;
  readonly createdAt: string | null;
}

/** Kept loose here so lifecycle rules do not depend on the analysis vocabulary. */
export interface EvidenceAnalysisRecord {
  readonly legibility: EvidenceLegibility;
  readonly observations: readonly {
    readonly field: string;
    readonly value: string;
    readonly confidence: number;
    readonly status: 'READ' | 'UNREADABLE';
  }[];
  readonly unreadableRegions: readonly string[];
}

/** True when PCNWatch actually holds the file, whatever has been done with it. */
export function isHeld(status: EvidenceStatus): boolean {
  return status !== 'DECLARED';
}

/**
 * Whether this item may contribute to the evidence basis.
 *
 * Three independent gates, and every one of them has to pass:
 *
 *   1. The user confirmed the readings. Not the model, not us.
 *   2. The file was legible. An unreadable photograph is a file we hold and
 *      cannot use, and calling it support would be the most flattering lie this
 *      product could tell.
 *   3. Something survived confirmation. A user who rejected every reading has
 *      told us the document does not say what we thought, which is worth
 *      knowing and is not support.
 *
 * Note what is absent: the model's confidence. It never appears here and never
 * will — a reading nobody checked is not made true by the model being sure.
 */
export function supportsAssessment(item: EvidenceItem): boolean {
  return (
    item.status === 'VERIFIED' && item.legibility !== 'UNREADABLE' && item.verifiedFacts.length > 0
  );
}

/**
 * Counts by type, split into what we hold and what actually supports the case.
 *
 * Two numbers rather than one because the evidence page and the assessment ask
 * different questions. The page asks "have I given them this?"; the engine asks
 * "does this back anything up?". They were the same number for as long as
 * uploading was impossible, and answering both from one count now is how an
 * upload would quietly become support.
 */
export interface EvidenceCounts {
  readonly held: Partial<Record<EvidenceType, number>>;
  readonly supporting: Partial<Record<EvidenceType, number>>;
}

export function countEvidence(items: readonly EvidenceItem[]): EvidenceCounts {
  const held: Partial<Record<EvidenceType, number>> = {};
  const supporting: Partial<Record<EvidenceType, number>> = {};
  for (const item of items) {
    if (isHeld(item.status)) held[item.type] = (held[item.type] ?? 0) + 1;
    if (supportsAssessment(item)) supporting[item.type] = (supporting[item.type] ?? 0) + 1;
  }
  return { held, supporting };
}
