import { z } from 'zod';

/**
 * Schema for rows returned by Camden's open PCN dataset.
 *
 * The dataset is published through a Socrata-style API which returns every column
 * as a string. Rather than assume exact column names, the adapter accepts a set of
 * plausible aliases per logical field and resolves them once, recording which alias
 * it used in the ingestion report. A source that changes its column names then
 * produces a loud validation failure instead of a silent field of nulls.
 */

/** Raw row: an object of scalar values. Anything else is rejected outright. */
export const rawRowSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
);

export type RawRow = z.infer<typeof rawRowSchema>;

/**
 * Logical fields and the source column names that may supply them.
 * Order matters: the first alias present in a row wins.
 */
export const FIELD_ALIASES = {
  recordId: ['pcn_id', 'pcn_reference', 'reference', 'id', 'ticket_id', 'notice_number'],
  contraventionCode: ['contravention_code', 'contravention', 'code', 'cont_code'],
  issuedTimestamp: [
    'issue_datetime',
    'date_time_issued',
    'issued_datetime',
    'observation_datetime',
    'datetime',
  ],
  issuedDate: ['issue_date', 'date_issued', 'date', 'ticket_date', 'observation_date'],
  issuedTime: ['issue_time', 'time_issued', 'time', 'observation_time'],
  street: ['street', 'street_name', 'location', 'road_name', 'street_location', 'place'],
  locality: ['locality', 'area', 'ward', 'ward_name'],
  postcode: ['postcode', 'post_code', 'postcode_district'],
  longitude: ['longitude', 'lon', 'lng', 'x', 'easting_wgs84'],
  latitude: ['latitude', 'lat', 'y', 'northing_wgs84'],
  enforcementType: ['ticket_type', 'type', 'enforcement_type', 'pcn_type'],
} as const satisfies Record<string, readonly string[]>;

export type LogicalField = keyof typeof FIELD_ALIASES;

/**
 * Fields that may be retained in `source_metadata`.
 *
 * Everything not listed here is dropped by the PII guard, including any column
 * the dataset gains in future. Adding a field to this list is a deliberate,
 * reviewable act.
 */
export const RETAINABLE_METADATA_FIELDS: readonly string[] = [
  'contravention_code',
  'contravention',
  'code',
  'cont_code',
  'ticket_type',
  'type',
  'enforcement_type',
  'pcn_type',
  'locality',
  'area',
  'ward',
  'ward_name',
  'street',
  'street_name',
  'road_name',
  'place',
];

/** Fields kept on an ingestion_errors excerpt so a human can debug a rejection. */
export const ERROR_EXCERPT_FIELDS: readonly string[] = [
  ...new Set([
    ...FIELD_ALIASES.recordId,
    ...FIELD_ALIASES.contraventionCode,
    ...FIELD_ALIASES.issuedTimestamp,
    ...FIELD_ALIASES.issuedDate,
    ...FIELD_ALIASES.street,
    ...FIELD_ALIASES.longitude,
    ...FIELD_ALIASES.latitude,
  ]),
];

export function resolveField(row: RawRow, field: LogicalField): { key: string; value: unknown } | null {
  for (const alias of FIELD_ALIASES[field]) {
    const value = row[alias];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return { key: alias, value };
    }
  }
  return null;
}

/**
 * Camden's approximate bounding box in WGS84.
 *
 * Used to reject coordinates that cannot plausibly be in the borough — swapped
 * lat/long, null island, or an unconverted British National Grid easting.
 * Padded generously; the point is to catch corruption, not to clip the boundary.
 */
export const CAMDEN_BBOX = {
  minLon: -0.24,
  minLat: 51.5,
  maxLon: -0.08,
  maxLat: 51.6,
} as const;
