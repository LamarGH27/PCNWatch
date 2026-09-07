import {
  EVIDENCE_FIELD_LABELS,
  isEvidenceField,
  type EvidenceAnalysis,
  type EvidenceField,
  type EvidenceObservation,
} from './analysis';
import { profileFor } from './profiles';
import type { VerifiedEvidenceFact } from './lifecycle';
import type { EvidenceType } from './types';

/**
 * The boundary between what a model read and what the case knows.
 *
 * Notice extraction already works this way — a field below
 * FIELD_VERIFICATION_THRESHOLD, or on the ALWAYS_VERIFY list, has to be
 * confirmed before it can drive anything. Evidence goes further: there is no
 * threshold, because *every* reading requires confirmation.
 *
 * That is a deliberate difference rather than an inconsistency. A notice is a
 * document we can ask the user to hold beside the screen, field by field, and
 * the fields are the same fourteen every time. A piece of evidence is a
 * photograph of a sign in the rain, or a receipt with a registration on it that
 * decides whether the whole document is about this car at all. A misread
 * character there does not produce a wrong date on a screen; it produces a
 * challenge that asserts something the document does not say.
 *
 * So confidence is displayed and never acted on. It tells the user where to
 * look hardest. It cannot promote a reading, skip a confirmation, or make an
 * item support a case.
 */

export interface EvidenceReadingForCheck {
  /** Position in the analysis. What the client sends back to confirm it. */
  readonly index: number;
  readonly field: EvidenceField;
  readonly label: string;
  readonly value: string;
  readonly confidence: number;
  readonly status: EvidenceObservation['status'];
  /** False for a reading there is nothing to agree with. */
  readonly confirmable: boolean;
  /** Shown beside a low-confidence reading. Never a reason to skip it. */
  readonly hint: string | null;
}

/** Below this the user is nudged to look twice. It changes nothing else. */
const LOOK_TWICE_BELOW = 0.85;

export function readingsForCheck(analysis: EvidenceAnalysis): readonly EvidenceReadingForCheck[] {
  return analysis.observations.map((observation, index) => ({
    index,
    field: observation.field,
    label: EVIDENCE_FIELD_LABELS[observation.field] ?? observation.field,
    value: observation.value,
    confidence: observation.confidence,
    status: observation.status,
    confirmable: observation.status === 'READ',
    hint:
      observation.status === 'UNREADABLE'
        ? 'We could not read this. If you can, you can add it by hand later.'
        : observation.confidence < LOOK_TWICE_BELOW
          ? 'We are less sure about this one. Worth checking against the document.'
          : null,
  }));
}

/**
 * Turns the user's confirmations into facts the engine may read.
 *
 * Confirmations arrive as indexes into the stored analysis, never as values. A
 * client cannot therefore confirm a reading into existence: if the index does
 * not point at a `READ` observation in the analysis we stored, nothing is
 * produced for it. The value that becomes a fact is the one we read and showed,
 * not one the browser sent back.
 */
export function verifiedFactsFrom(
  analysis: EvidenceAnalysis,
  confirmedIndexes: readonly number[],
): readonly VerifiedEvidenceFact[] {
  const wanted = new Set(confirmedIndexes);
  const facts: VerifiedEvidenceFact[] = [];
  analysis.observations.forEach((observation, index) => {
    if (!wanted.has(index)) return;
    if (observation.status !== 'READ') return;
    facts.push({ field: observation.field, value: observation.value });
  });
  return facts;
}

/**
 * Drops anything the reader returned that this kind of document may not carry.
 *
 * Applied to the response before it is stored, so an out-of-profile reading
 * never reaches the database, the confirmation screen or a comparison. See
 * profiles.ts for why this is a filter rather than an instruction.
 */
export function withinProfile(
  type: EvidenceType,
  analysis: EvidenceAnalysis,
): EvidenceAnalysis {
  const profile = profileFor(type);
  const permitted = new Set<string>(profile?.fields ?? []);
  return {
    ...analysis,
    observations: analysis.observations.filter(
      (o) => isEvidenceField(o.field) && permitted.has(o.field),
    ),
  };
}
