/**
 * Personal-data guard for ingestion.
 *
 * Open datasets occasionally leak fields they should not contain — a vehicle
 * registration in a free-text column, a permit holder's name, an officer's badge
 * number. PCNWatch's enforcement tables are public, so anything that reaches them
 * is effectively published.
 *
 * The rule enforced here is allow-list, not deny-list: a source field is copied
 * into `source_metadata` only if the adapter explicitly names it. Everything else
 * is dropped. On top of that, retained values are scrubbed for registration-shaped
 * text, so a leak in an allowed field still cannot get through.
 */

/**
 * UK vehicle registration formats.
 *
 * The first three are specific enough to be safe anywhere: each requires a
 * letters-digits-letters structure that ordinary text does not produce by
 * accident. A false positive here redacts a value we did not need, which is the
 * cheap direction to be wrong in.
 */
const SPECIFIC_VRM_PATTERNS: readonly RegExp[] = [
  /\b[A-Z]{2}\d{2}\s?[A-Z]{3}\b/gi, // AB12 CDE
  /\b[A-Z]\d{1,3}\s?[A-Z]{3}\b/gi, // A123 BCD
  /\b[A-Z]{3}\s?\d{1,3}[A-Z]\b/gi, // ABC 123D
];

/**
 * Dateless and older formats: one to three letters followed by digits.
 *
 * This shape is genuinely ambiguous. "NW1" is a dateless registration and it is
 * also a London postcode district; "A5" is a registration and it is also a road
 * number. Shape alone cannot separate them, so the field decides — see
 * `RedactionContext`.
 */
const DATELESS_VRM_PATTERN = /\b[A-Z]{1,3}\s?\d{1,4}\b/gi;

/**
 * How aggressively to read a value as a registration.
 *
 * `free-text` applies every pattern, including the ambiguous dateless one. It is
 * the default, because an unrecognised column is exactly where a leak hides.
 *
 * `location` applies only the three specific formats. A location column is
 * published to say *where*, and its postcode districts, road numbers and
 * junction references are load-bearing — they are the tokens a street-reference
 * lookup matches on, and redacting them destroys the geography while protecting
 * nothing that the field-name allow-list has not already blocked. A genuine
 * modern registration leaked into a street column is still removed.
 */
export type RedactionContext = 'free-text' | 'location';

/** Field names whose content is locational, so the dateless pattern is skipped. */
const LOCATION_FIELD_HINTS: readonly string[] = [
  'street',
  'road',
  'location',
  'place',
  'locality',
  'area',
  'ward',
  'zone',
  'postcode',
  'district',
  'borough',
];

export function redactionContextFor(fieldName: string): RedactionContext {
  const normalised = fieldName.toLowerCase().replace(/[^a-z0-9]/g, '_');
  return LOCATION_FIELD_HINTS.some((hint) => normalised.includes(hint))
    ? 'location'
    : 'free-text';
}

/** Field names that must never be retained, whatever an adapter asks for. */
const FORBIDDEN_FIELD_HINTS: readonly string[] = [
  'vrm',
  'vrn',
  'registration',
  'reg_no',
  'regno',
  'plate',
  'vehicle_reg',
  'keeper',
  'owner',
  'driver',
  'name',
  'surname',
  'forename',
  'address',
  'postcode_full',
  'email',
  'phone',
  'telephone',
  'permit_holder',
  'badge',
  'officer',
  'ceo_id',
  'nino',
  'dob',
  'date_of_birth',
];

export const REDACTION_PLACEHOLDER = '[redacted]';

export function isForbiddenField(fieldName: string): boolean {
  const normalised = fieldName.toLowerCase().replace(/[^a-z0-9]/g, '_');
  return FORBIDDEN_FIELD_HINTS.some(
    (hint) => normalised === hint || normalised.includes(hint),
  );
}

/** Replaces registration-shaped substrings in free text. */
export function redactRegistrations(
  value: string,
  context: RedactionContext = 'free-text',
): string {
  const patterns =
    context === 'location'
      ? SPECIFIC_VRM_PATTERNS
      : [...SPECIFIC_VRM_PATTERNS, DATELESS_VRM_PATTERN];
  let result = value;
  for (const pattern of patterns) {
    result = result.replace(pattern, REDACTION_PLACEHOLDER);
  }
  return result;
}

export function containsRegistration(
  value: string,
  context: RedactionContext = 'free-text',
): boolean {
  const patterns =
    context === 'location'
      ? SPECIFIC_VRM_PATTERNS
      : [...SPECIFIC_VRM_PATTERNS, DATELESS_VRM_PATTERN];
  return patterns.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  });
}

export interface SanitisationResult {
  readonly metadata: Record<string, unknown>;
  /** Fields dropped because they were not on the allow-list. */
  readonly droppedFields: readonly string[];
  /** Fields dropped because their name matched a forbidden hint. */
  readonly forbiddenFields: readonly string[];
  /** Allowed fields whose value was scrubbed. */
  readonly redactedFields: readonly string[];
}

/**
 * Builds the metadata blob retained alongside an ingested row.
 *
 * @param row      the raw source record
 * @param allowed  field names the adapter has explicitly declared safe to retain
 */
export function sanitiseSourceMetadata(
  row: Record<string, unknown>,
  allowed: readonly string[],
): SanitisationResult {
  const metadata: Record<string, unknown> = {};
  const droppedFields: string[] = [];
  const forbiddenFields: string[] = [];
  const redactedFields: string[] = [];
  const allowedSet = new Set(allowed);

  for (const [key, value] of Object.entries(row)) {
    if (isForbiddenField(key)) {
      forbiddenFields.push(key);
      continue;
    }
    if (!allowedSet.has(key)) {
      droppedFields.push(key);
      continue;
    }
    if (typeof value === 'string') {
      const cleaned = redactRegistrations(value, redactionContextFor(key));
      if (cleaned !== value) redactedFields.push(key);
      metadata[key] = cleaned;
      continue;
    }
    if (value === null || typeof value === 'number' || typeof value === 'boolean') {
      metadata[key] = value;
      continue;
    }
    // Nested objects and arrays are not retained: their shape is not reviewable,
    // so they cannot be shown to be free of personal data.
    droppedFields.push(key);
  }

  return { metadata, droppedFields, forbiddenFields, redactedFields };
}

/**
 * Scrubs a payload before it is stored on an ingestion_errors row.
 *
 * Rejected rows are the most likely to contain something unexpected, so the
 * excerpt keeps only the fields that help a human debug the rejection, with any
 * remaining registration-shaped text removed.
 */
export function sanitiseErrorExcerpt(
  row: unknown,
  keepFields: readonly string[],
): Record<string, unknown> | null {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return null;
  const excerpt: Record<string, unknown> = {};
  for (const key of keepFields) {
    const value = (row as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (isForbiddenField(key)) {
      excerpt[key] = REDACTION_PLACEHOLDER;
      continue;
    }
    if (typeof value === 'string') {
      excerpt[key] = redactRegistrations(value, redactionContextFor(key)).slice(0, 200);
    } else if (value === null || typeof value === 'number' || typeof value === 'boolean') {
      excerpt[key] = value;
    }
  }
  return excerpt;
}
