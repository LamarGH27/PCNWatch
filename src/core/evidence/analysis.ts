import type { EvidenceLegibility } from './lifecycle';

/**
 * The closed vocabulary of things a reading pass may report.
 *
 * Closed for the same reason the narrative assertion kinds are closed: an open
 * field name is a place for a model to write whatever it likes, and whatever it
 * likes eventually includes a conclusion. There is no field here for "is this
 * valid", "does this help", "was the restriction in force" or anything else
 * that requires a judgement. Every member is a thing printed on a document or
 * visible in a photograph, which a person could point at.
 *
 * A reading is a transcription. What it means is decided elsewhere, from rules,
 * by code that cannot see the image.
 */
export const EVIDENCE_FIELDS = [
  'VEHICLE_REGISTRATION',
  'DATE',
  'TIME_FROM',
  'TIME_TO',
  'VALID_FROM',
  'VALID_TO',
  'AMOUNT',
  'LOCATION_TEXT',
  'ZONE_OR_BAY_IDENTIFIER',
  'REFERENCE_NUMBER',
  'PROVIDER_NAME',
  'ISSUING_BODY',
  'PERMIT_TYPE',
  'BADGE_SERIAL',
  'CONTRAVENTION_CODE',
  'SIGN_RESTRICTION_TEXT',
  'SIGN_CONTROLLED_HOURS',
  'MARKINGS_DESCRIPTION',
  'VEHICLE_POSITION_DESCRIPTION',
] as const;

export type EvidenceField = (typeof EVIDENCE_FIELDS)[number];

/** How each reading is put to the user when they are asked to confirm it. */
export const EVIDENCE_FIELD_LABELS: Record<EvidenceField, string> = {
  VEHICLE_REGISTRATION: 'Vehicle registration',
  DATE: 'Date',
  TIME_FROM: 'From',
  TIME_TO: 'Until',
  VALID_FROM: 'Valid from',
  VALID_TO: 'Valid until',
  AMOUNT: 'Amount',
  LOCATION_TEXT: 'Location as written',
  ZONE_OR_BAY_IDENTIFIER: 'Zone or bay number',
  REFERENCE_NUMBER: 'Reference number',
  PROVIDER_NAME: 'Provider',
  ISSUING_BODY: 'Issued by',
  PERMIT_TYPE: 'Type of permit',
  BADGE_SERIAL: 'Badge serial number',
  CONTRAVENTION_CODE: 'Contravention code',
  SIGN_RESTRICTION_TEXT: 'What the sign says',
  SIGN_CONTROLLED_HOURS: 'Hours shown on the sign',
  MARKINGS_DESCRIPTION: 'Road markings visible',
  VEHICLE_POSITION_DESCRIPTION: 'Where the vehicle is in the photograph',
};

export const EVIDENCE_OBSERVATION_STATUSES = ['READ', 'UNREADABLE'] as const;

export type EvidenceObservationStatus = (typeof EVIDENCE_OBSERVATION_STATUSES)[number];

/**
 * One thing read off one document.
 *
 * `UNREADABLE` is a first-class answer, not a failure. "There is a date here
 * and I cannot make it out" and "there is no date here" are different facts
 * about a document, and flattening them is how a blurred photograph turns into
 * a confident blank.
 */
export interface EvidenceObservation {
  readonly field: EvidenceField;
  /** Verbatim, as printed or visible. Never normalised, never inferred. */
  readonly value: string;
  readonly confidence: number;
  readonly status: EvidenceObservationStatus;
}

export interface EvidenceAnalysis {
  readonly legibility: EvidenceLegibility;
  readonly observations: readonly EvidenceObservation[];
  readonly unreadableRegions: readonly string[];
}

export function isEvidenceField(value: unknown): value is EvidenceField {
  return typeof value === 'string' && (EVIDENCE_FIELDS as readonly string[]).includes(value);
}

/**
 * The readings a user may be asked to confirm.
 *
 * Only `READ` observations. An unreadable one is shown on the page — the user
 * should know we tried and failed — but there is nothing to agree with, so it
 * is not offered as something to tick.
 */
export function confirmableObservations(
  analysis: EvidenceAnalysis,
): readonly EvidenceObservation[] {
  return analysis.observations.filter((o) => o.status === 'READ');
}
