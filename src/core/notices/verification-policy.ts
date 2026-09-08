/**
 * When a field the reader produced has to be checked by a person.
 *
 * Named once, here, because three separate places consult it — the extraction
 * pipeline that marks fields, the compact summary that decides what one tap may
 * confirm, and the tests that pin both. Two copies of a threshold is two
 * standards, and the one that drifts is always the one nobody is looking at.
 */

/** Below this a field must be confirmed by the user before it is used. */
export const FIELD_VERIFICATION_THRESHOLD = 0.85;

/** Fields that always require confirmation, however confident the model is. */
export const ALWAYS_VERIFY: readonly string[] = [
  'pcnNumber',
  'contraventionCode',
  'incidentDate',
  'issueDate',
  'fullAmountPence',
];
