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

/**
 * A Socrata "point" / "location" column, which arrives as a nested object rather
 * than a scalar. This is the shape most likely to differ between a hand-written
 * fixture and the live dataset, so it is modelled explicitly rather than being
 * treated as an unexpected value.
 *
 * Socrata emits two variants:
 *   - legacy `location`: { latitude: "51.53", longitude: "-0.13", human_address }
 *   - GeoJSON `point`:   { type: "Point", coordinates: [lon, lat] }
 */
const latLonPointSchema = z
  .object({
    latitude: z.union([z.string(), z.number()]),
    longitude: z.union([z.string(), z.number()]),
  })
  .loose();

const geoJsonPointSchema = z
  .object({
    type: z.literal('Point'),
    coordinates: z.tuple([z.number(), z.number()]),
  })
  .loose();

/**
 * Raw row.
 *
 * Values may be scalars or nested objects. A nested value never rejects the row —
 * an unrecognised one is simply not usable as a field, and the PII guard drops it
 * from retained metadata because its shape cannot be reviewed. Rejecting the whole
 * row would mean one new column on the source discards the entire dataset.
 */
export const rawRowSchema = z.record(z.string(), z.unknown());

export type RawRow = z.infer<typeof rawRowSchema>;

/** Extracts coordinates from a Socrata point/location column, if that is what it is. */
export function readSocrataPoint(value: unknown): { longitude: number; latitude: number } | null {
  const geoJson = geoJsonPointSchema.safeParse(value);
  if (geoJson.success) {
    const [longitude, latitude] = geoJson.data.coordinates;
    return { longitude, latitude };
  }

  const latLon = latLonPointSchema.safeParse(value);
  if (latLon.success) {
    const longitude = Number(latLon.data.longitude);
    const latitude = Number(latLon.data.latitude);
    if (Number.isFinite(longitude) && Number.isFinite(latitude)) return { longitude, latitude };
  }

  return null;
}

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

/**
 * Resolves a logical field to the first alias present as a usable *scalar*.
 *
 * Nested values are skipped rather than stringified: `String({})` yields
 * "[object Object]", which would sail through as a street name.
 */
export function resolveField(row: RawRow, field: LogicalField): { key: string; value: unknown } | null {
  for (const alias of FIELD_ALIASES[field]) {
    const value = row[alias];
    if (value === undefined || value === null) continue;
    if (typeof value === 'object') continue;
    if (String(value).trim() === '') continue;
    return { key: alias, value };
  }
  return null;
}

/** Column names that may carry a Socrata point/location object. */
export const POINT_FIELD_CANDIDATES: readonly string[] = [
  'location',
  'point',
  'geocoded_column',
  'the_geom',
  'coordinates',
  'geo_point',
  'geom',
];

/** Finds coordinates in whichever column carries them, if any. */
export function resolvePoint(
  row: RawRow,
): { key: string; longitude: number; latitude: number } | null {
  for (const key of POINT_FIELD_CANDIDATES) {
    const point = readSocrataPoint(row[key]);
    if (point) return { key, ...point };
  }
  // Fall back to scanning every column, so a differently named point column still
  // works rather than silently costing us every coordinate in the dataset.
  for (const [key, value] of Object.entries(row)) {
    if (typeof value !== 'object' || value === null) continue;
    const point = readSocrataPoint(value);
    if (point) return { key, ...point };
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
